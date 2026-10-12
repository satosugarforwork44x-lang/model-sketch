// model/ui/loaders.js — STL / 3MF / OBJ / GLB を読んで、部品ごとの形（mm・Z が上・底の中心が原点）にする
import * as THREE from "./vendor/three.module.js";
import { STLLoader } from "./vendor/addons/loaders/STLLoader.js";
import { unzipSync, strFromU8 } from "./vendor/addons/libs/fflate.module.js";
import { OBJLoader } from "./vendor/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "./vendor/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "./vendor/addons/libs/meshopt_decoder.module.js";

const MAX_PARTS = 300;
const idOf = (s) => (String(s || "").normalize("NFKC").replace(/[^\w-]+/g, "_").replace(/^[^A-Za-z_]+/, "").slice(0, 32));

let draco = null;
function gltfLoader() {
  const l = new GLTFLoader();
  if (!draco) { draco = new DRACOLoader(); draco.setDecoderPath(new URL("./vendor/addons/libs/draco/gltf/", import.meta.url).href); }
  l.setDRACOLoader(draco);
  l.setMeshoptDecoder(MeshoptDecoder);
  return l;
}

/** 形だけ（位置）にして、三角形ごとにばらした BufferGeometry を返す */
function plain(geom, matrix) {
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", geom.attributes.position.clone());
  if (geom.index) g.setIndex(geom.index.clone());
  if (matrix) g.applyMatrix4(matrix);
  if (g.index) g = g.toNonIndexed();
  return g;
}

/** 部品の色: 材質の色。白で頂点の色があれば、その平均 */
function colorOf(mat, geom) {
  const c = mat?.color?.clone?.() || null, vc = geom.attributes.color;
  if (vc && (!c || c.getHex() === 0xffffff)) {
    let r = 0, g = 0, b = 0;
    const n = Math.min(vc.count, 20000);
    for (let i = 0; i < n; i++) { r += vc.getX(i); g += vc.getY(i); b += vc.getZ(i); }
    return "#" + new THREE.Color(r / n, g / n, b / n).getHexString();
  }
  return c && c.getHex() !== 0xffffff ? "#" + c.getHexString() : null;
}

function collect(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || parts.length >= MAX_PARTS) return;
    if (o.geometry.attributes.position.count < 3) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const name = o.name || o.parent?.name || "";
    parts.push({ name, geom: plain(o.geometry, o.matrixWorld), color: colorOf(mat, o.geometry) });
  });
  return parts;
}

// ---------- 3MF（自前）: Bambu Studio・PrusaSlicer の「形を別のファイルに置く」作り（Production 拡張）にも対応 ----------
const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const MAX_TRIS = 6_000_000;
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const norm = (p) => "/" + String(p).replace(/^\/+/, "");
function m3mf(t) {            // "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"（点は行ベクトル）
  const m = new THREE.Matrix4();
  if (!t) return m;
  const v = t.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return m;
  return m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
}
export function parse3MF(buf) {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => /\.(model|rels)$/i.test(f.name) });
  const text = Object.fromEntries(Object.entries(files).map(([k, v]) => [norm(k), strFromU8(v)]));
  const rels = text["/_rels/.rels"] || "";
  const root = norm((rels.match(/Target="([^"]+\.model)"/i) || [, "/3D/3dmodel.model"])[1]);
  if (!text[root]) throw new Error("3mf: no model");
  const objects = new Map();          // "path#id" → { name, mesh?: {v, t}, comps?: [{key, m}] }
  for (const [path, xml] of Object.entries(text)) {
    if (!path.endsWith(".model")) continue;
    for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const a = attrs(o[1]), body = o[2], obj = { name: unesc(a.name || "") };
      const mesh = body.match(/<mesh\b[\s\S]*?<\/mesh>/);
      if (mesh) {
        const v = [], t = [];
        for (const m of mesh[0].matchAll(/<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g)) v.push(+m[1], +m[2], +m[3]);
        for (const m of mesh[0].matchAll(/<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g)) t.push(+m[1], +m[2], +m[3]);
        obj.mesh = { v, t };
      } else {
        obj.comps = [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => {
          const ca = attrs(c[1]);
          return { key: `${ca["p:path"] ? norm(ca["p:path"]) : path}#${ca.objectid}`, m: m3mf(ca.transform) };
        });
      }
      objects.set(`${path}#${a.id}`, obj);
    }
  }
  const scale = UNITS[(text[root].match(/<model\b[^>]*\bunit="(\w+)"/) || [])[1]] ?? 1;
  const parts = [];
  let total = 0;
  for (const it of text[root].matchAll(/<item\b([^>]*)\/?>/g)) {
    const a = attrs(it[1]), key = `${root}#${a.objectid}`, top = objects.get(key);
    if (!top || a.printable === "0") continue;
    const chunks = [];
    const walk = (k, m, depth) => {
      const o = objects.get(k);
      if (!o || depth > 16) return;
      if (o.mesh) {
        const { v, t } = o.mesh, out = new Float32Array(t.length * 3), p = new THREE.Vector3();
        total += t.length / 3;
        if (total > MAX_TRIS) throw new Error("3mf: too large");
        for (let i = 0; i < t.length; i++) {
          const j = t[i] * 3;
          p.set(v[j], v[j + 1], v[j + 2]).applyMatrix4(m);
          out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z;
        }
        chunks.push(out);
      }
      for (const c of o.comps || []) walk(c.key, m.clone().multiply(c.m), depth + 1);
    };
    walk(key, new THREE.Matrix4().makeScale(scale, scale, scale).multiply(m3mf(a.transform)), 0);
    if (!chunks.length) continue;
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(all, 3));
    parts.push({ name: top.name, geom: g, color: null });
  }
  return parts;
}

/**
 * buf: ArrayBuffer, ext: ".stl" など, opt: { scale, upY }
 * 戻り値: { parts: [{ id, name, geom, color }], offset: [x,y,z], raw: {size} }
 */
export async function loadModel(buf, ext, { scale = 1, upY = false } = {}) {
  let parts;
  switch (ext) {
    case ".stl": parts = [{ name: "", geom: plain(new STLLoader().parse(buf)), color: null }]; break;
    case ".3mf": parts = parse3MF(buf); break;
    case ".obj": parts = collect(new OBJLoader().parse(new TextDecoder().decode(buf))); break;
    case ".glb": case ".gltf": {
      const gltf = await new Promise((ok, ng) => gltfLoader().parse(buf, "", ok, ng));
      parts = collect(gltf.scene);
      break;
    }
    default: throw new Error(`unsupported ${ext}`);
  }
  if (!parts.length) throw new Error("empty");
  // 単位と向き → mm・Z が上
  const m = new THREE.Matrix4().makeScale(scale, scale, scale);
  if (upY) m.premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const box = new THREE.Box3();
  for (const p of parts) { p.geom.applyMatrix4(m); p.geom.computeBoundingBox(); box.union(p.geom.boundingBox); }
  // 底の中心を原点に置く（レシピの座標はこの置き方が基準）
  const off = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z);
  const used = new Set();
  parts.forEach((p, i) => {
    p.geom.translate(off.x, off.y, off.z);
    p.geom.computeVertexNormals();
    const named = idOf(p.name);
    let id = parts.length === 1 ? "base" : /[A-Za-z0-9]/.test(named) ? named : `part${i + 1}`;
    while (used.has(id)) id = `${id}_${i + 1}`;
    used.add(id);
    p.id = id;
    p.name = p.name || id;
  });
  return { parts, offset: off.toArray().map((v) => +v.toFixed(4)) };
}

export function triCount(geom) { return geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3; }

/** 閉じた形の体積（mm³）。閉じていない形では目安にしかならない */
export function volumeOf(geom) {
  const p = geom.attributes.position.array;
  let v = 0;
  if (geom.index) return 0;
  for (let i = 0; i < p.length; i += 9) {
    v += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
  }
  return Math.abs(v);
}
