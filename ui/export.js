// model/ui/export.js — 書き出し。STL（バイナリ）/ 3MF（部品ごとに 1 つの物体）/ GLB（ゲーム向け: m・Y が上・部品ごとの色）
import * as THREE from "./vendor/three.module.js";
import { GLTFExporter } from "./vendor/addons/exporters/GLTFExporter.js";
import { mergeVertices } from "./vendor/addons/utils/BufferGeometryUtils.js";
import { zipSync, strToU8 } from "./vendor/addons/libs/fflate.module.js";

/** bodies: [{ id, geom }]（mm・Z が上）→ バイナリ STL（全部を 1 つに） */
export function toSTL(bodies) {
  const tris = bodies.reduce((n, b) => n + b.geom.attributes.position.count / 3, 0);
  const buf = new ArrayBuffer(84 + tris * 50), dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode("Model Sketch (Hub) binary STL, mm".padEnd(80, " ")));
  dv.setUint32(80, tris, true);
  let o = 84;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const body of bodies) {
    const p = body.geom.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      for (const v of [n, a, b, c]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

/** bodies → 3MF（単位 mm。部品ごとに object と build item） */
export function to3MF(bodies) {
  const objs = [], items = [];
  bodies.forEach((body, k) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", body.geom.attributes.position.clone());
    const m = mergeVertices(g, 1e-5);
    const p = m.attributes.position, idx = m.index;
    const v = [], t = [];
    for (let i = 0; i < p.count; i++) v.push(`<vertex x="${+p.getX(i).toFixed(5)}" y="${+p.getY(i).toFixed(5)}" z="${+p.getZ(i).toFixed(5)}"/>`);
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
      if (a !== b && b !== c && a !== c) t.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    objs.push(`<object id="${k + 1}" name="${esc(body.id)}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${k + 1}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">Model Sketch (Hub)</metadata><resources>${objs.join("")}</resources><build>${items.join("")}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    "3D/3dmodel.model": strToU8(model),
  });
}

/**
 * bodies: [{ id, geom, color, tri, material }] → GLB（m・Y が上。原点は今の原点＝底の中心。部品ごとに 1 つのノード）
 * 色は「パレット画像」方式: 使った色を小さな画像に並べ、各面がそのマスを指す（UV）。Unity・Godot・three.js の普通の材質で色が出る
 */
export async function toGLB(bodies, { base = "#c8ccd2" } = {}) {
  const colors = [];
  const idx = (hex) => { const h = hex.toUpperCase(); let i = colors.indexOf(h); if (i < 0) { i = colors.length; colors.push(h); } return i; };
  for (const b of bodies) { idx(b.color || base); for (const c of b.tri || []) if (c) idx(c); }
  if (colors.length > 1024) throw new Error("色が多すぎます（1024 色まで）");
  const cells = Math.max(2, 2 ** Math.ceil(Math.log2(Math.ceil(Math.sqrt(colors.length))))), px = 4, size = cells * px;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  colors.forEach((c, i) => { g.fillStyle = c; g.fillRect((i % cells) * px, Math.floor(i / cells) * px, px, px); });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  tex.flipY = false;
  tex.name = "palette";
  const mats = new Map();
  const matOf = (kind) => {
    if (!mats.has(kind)) {
      const [roughness, metalness] = { plastic: [0.5, 0], matte: [0.95, 0], gloss: [0.15, 0], metal: [0.32, 1] }[kind] || [0.5, 0];
      mats.set(kind, new THREE.MeshStandardMaterial({ map: tex, roughness, metalness, name: `palette_${kind}` }));
    }
    return mats.get(kind);
  };
  const scene = new THREE.Scene();
  const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(0.001, 0.001, 0.001));
  for (const b of bodies) {
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", b.geom.attributes.position.clone());
    g2.applyMatrix4(m);
    const n = g2.attributes.position.count, uv = new Float32Array(n * 2), bi = idx(b.color || base);
    for (let t = 0; t < n / 3; t++) {
      const ci = b.tri?.[t] ? idx(b.tri[t]) : bi, u = ((ci % cells) + 0.5) / cells, v = (Math.floor(ci / cells) + 0.5) / cells;
      for (let k = 0; k < 3; k++) { uv[(t * 3 + k) * 2] = u; uv[(t * 3 + k) * 2 + 1] = v; }
    }
    g2.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g2.computeVertexNormals();      // 三角形ごとの頂点なので、角はくっきり（ローポリ向き）
    g2.name = b.id;
    const mesh = new THREE.Mesh(g2, matOf(b.material || "plastic"));
    mesh.name = b.id;
    scene.add(mesh);
  }
  const ab = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Uint8Array(ab);
}
