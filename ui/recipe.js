// model/ui/recipe.js — レシピ（steps）を manifold で計算する。Claude が書くのは JSON の手順だけで、計算はここで行う
// ・座標は mm・Z が上。元のファイルの形は「底の中心が原点」に置いたもの（loaders.js）
// ・box / cylinder の at は「底の面の中心」、sphere の at は中心
import * as THREE from "./vendor/three.module.js";

let wasmP = null;
/** manifold（wasm）を読み込む。.wasm の種類（MIME）に頼らないよう、バイト列を渡して起動する */
export function manifold() {
  wasmP ??= (async () => {
    const bin = await (await fetch(new URL("./vendor/manifold.wasm", import.meta.url))).arrayBuffer();
    const Module = (await import("./vendor/manifold.js")).default;
    const w = await Module({ wasmBinary: bin });
    w.setup();
    return w;
  })();
  return wasmP;
}

const ID = /^[A-Za-z_][\w-]{0,39}$/;
export class StepError extends Error {}

/** 形（三角形ごと）→ Manifold。閉じていない形は StepError */
export function toManifold(w, geom) {
  const pos = geom.attributes.position.array;
  const mesh = new w.Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) });
  mesh.merge();
  let m;
  try { m = new w.Manifold(mesh); } catch { throw new StepError("not-manifold"); }
  if (m.status() !== "NoError" || m.isEmpty()) { m.delete(); throw new StepError("not-manifold"); }
  return m;
}

/** Manifold → 三角形ごとの BufferGeometry（角がくっきり見える）。面積 0 の三角形は除く（書き出しで「閉じていない」扱いになるため） */
export function toGeometry(m) {
  const mesh = m.getMesh(), np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const out = new Float32Array(tv.length * 3);
  let n = 0;
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * cx + cy * cy + cz * cz < 1e-18) continue;
    for (const i of [a, b, c]) { out[n++] = vp[i]; out[n++] = vp[i + 1]; out[n++] = vp[i + 2]; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out.slice(0, n), 3));
  g.computeVertexNormals();
  return g;
}

// ---------- 数値（params の $名前 と、簡単な式） ----------
export function resolve(value, params) {
  if (typeof value === "string" && value.includes("$")) {
    const expr = value.replace(/\$([A-Za-z_][\w-]*)/g, (_, k) => {
      if (!(k in params)) throw new StepError(`params に ${k} がありません`);
      return `(${Number(params[k].value)})`;
    });
    if (!/^[\d\s.+\-*/()eE]+$/.test(expr)) throw new StepError(`式が読めません: ${value}`);
    const v = Function(`"use strict";return (${expr});`)();
    if (!Number.isFinite(v)) throw new StepError(`式が数になりません: ${value}`);
    return v;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, params)]));
  return value;
}
const num = (v, name, { min = -1e6, max = 1e6, def } = {}) => {
  if (v === undefined && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new StepError(`${name} は数で書いてください`);
  if (n < min || n > max) throw new StepError(`${name} は ${min}〜${max}`);
  return n;
};
const vec = (v, name, def) => {
  if (v === undefined && def) return def;
  if (!Array.isArray(v) || v.length !== 3) throw new StepError(`${name} は [x, y, z]`);
  return v.map((x, i) => num(x, `${name}[${i}]`));
};
const segs = (d) => Math.max(24, Math.min(160, Math.round(d * 3)));
const AXIS_ROT = { z: [0, 0, 0], x: [0, 90, 0], y: [-90, 0, 0] };

/**
 * doc: { params, steps }, sources: Map(id → geom)
 * 戻り値: { bodies: [{ id, geom, from }], errors: [{ i, msg }], used: Set(source ids) }
 */
export async function runRecipe(doc, sources, cache) {
  const steps = doc.steps || [];
  const out = { bodies: [], errors: [], computed: false };
  if (!steps.length) {
    for (const [id, geom] of sources) out.bodies.push({ id, geom, from: "source" });
    return out;
  }
  const w = await manifold();
  const trash = [];
  const keep = (m) => { trash.push(m); return m; };
  const env = new Map();          // id → Manifold（計算した物） / 元の形は使うときに変換する
  const order = [];               // 出す順
  const consumed = new Set();
  const params = doc.params || {};
  const get = (id, name = "of") => {
    if (typeof id !== "string") throw new StepError(`${name} に部品の名前を書いてください`);
    if (env.has(id)) return env.get(id);
    if (sources.has(id)) {
      let m = cache.get(id);
      if (!m) { m = toManifold(w, sources.get(id)); cache.set(id, m); }
      return m;
    }
    throw new StepError(`部品 ${id} がありません`);
  };
  const put = (id, m) => {
    if (!ID.test(String(id))) throw new StepError(`id「${id}」は英字で始まる英数字（_ -）にしてください`);
    env.set(id, m);
    consumed.delete(id);
    if (!order.includes(id)) order.push(id);
  };
  const list = (v, name) => (Array.isArray(v) ? v : [v]).map((x) => get(x, name));

  for (let i = 0; i < steps.length; i++) {
    let s;
    try {
      s = resolve(steps[i], params);
      if (s.skip) continue;
      const op = String(s.op || "");
      switch (op) {
        case "box": {
          const size = vec(s.size, "size"), at = vec(s.at, "at", [0, 0, 0]);
          if (size.some((v) => v <= 0)) throw new StepError("size は 0 より大きく");
          put(s.id, keep(w.Manifold.cube(size, true).translate([at[0], at[1], at[2] + size[2] / 2])));
          break;
        }
        case "cylinder": {
          const h = num(s.h, "h", { min: 1e-3 }), d1 = num(s.d ?? s.d1, "d", { min: 0 }), d2 = num(s.d2 ?? s.d ?? s.d1, "d2", { min: 0 });
          const at = vec(s.at, "at", [0, 0, 0]), axis = s.axis || "z";
          if (!AXIS_ROT[axis]) throw new StepError("axis は x / y / z");
          let m = keep(w.Manifold.cylinder(h, d1 / 2, d2 / 2, num(s.segments, "segments", { min: 3, max: 512, def: segs(Math.max(d1, d2)) })));
          if (axis !== "z") m = keep(m.rotate(AXIS_ROT[axis]));
          put(s.id, keep(m.translate(at)));
          break;
        }
        case "sphere": {
          const d = num(s.d, "d", { min: 1e-3 });
          put(s.id, keep(w.Manifold.sphere(d / 2, num(s.segments, "segments", { min: 4, max: 512, def: segs(d) })).translate(vec(s.at, "at", [0, 0, 0]))));
          break;
        }
        case "polygon": {          // 平らな形を押し出す（points は XY の [[x,y],…]、z から高さ h）
          if (!Array.isArray(s.points) || s.points.length < 3) throw new StepError("points は 3 点以上の [[x, y], …]");
          const pts = s.points.map((p, k) => [num(p?.[0], `points[${k}][0]`), num(p?.[1], `points[${k}][1]`)]);
          const cs = keep(new w.CrossSection([pts], "Positive"));
          put(s.id, keep(cs.extrude(num(s.h, "h", { min: 1e-3 })).translate([0, 0, num(s.z, "z", { def: 0 })])));
          break;
        }
        case "union": case "subtract": case "intersect": {
          const from = s.from ?? s.of, base = get(from, "from"), tools = list(s.with, "with");
          let m = base;
          for (const t of tools) m = keep(op === "union" ? m.add(t) : op === "subtract" ? m.subtract(t) : m.intersect(t));
          if (!s.keep) for (const t of [].concat(s.with)) if (t !== (s.id ?? from)) consumed.add(t);
          put(s.id ?? from, m);
          break;
        }
        case "translate": put(s.id ?? s.of, keep(get(s.of).translate(vec(s.by, "by")))); break;
        case "rotate": {
          const deg = vec(s.deg, "deg"), about = vec(s.about, "about", [0, 0, 0]);
          put(s.id ?? s.of, keep(get(s.of).translate(about.map((v) => -v)).rotate(deg).translate(about)));
          break;
        }
        case "scale": {
          const by = Array.isArray(s.by) ? vec(s.by, "by") : [num(s.by, "by"), num(s.by, "by"), num(s.by, "by")];
          if (by.some((v) => v <= 0)) throw new StepError("by は 0 より大きく");
          put(s.id ?? s.of, keep(get(s.of).scale(by)));
          break;
        }
        case "mirror": put(s.id ?? s.of, keep(get(s.of).mirror(vec(s.normal, "normal")))); break;
        case "copy": put(s.id, get(s.of)); break;
        case "place": {            // 台に置く: 底を z=0 に（x, y は at で）
          const m = get(s.of), bb = m.boundingBox(), at = s.at ? [num(s.at[0], "at[0]"), num(s.at[1], "at[1]")] : [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2];
          put(s.id ?? s.of, keep(m.translate([at[0] - (bb.min[0] + bb.max[0]) / 2, at[1] - (bb.min[1] + bb.max[1]) / 2, -bb.min[2]])));
          break;
        }
        case "cut": {              // 平面で 2 つに切る。ids: [下（小さい側）, 上（大きい側）]
          const axis = s.axis || "z", n = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
          if (!n) throw new StepError("axis は x / y / z");
          const ids = Array.isArray(s.ids) && s.ids.length === 2 ? s.ids : [`${s.of}_lo`, `${s.of}_hi`];
          const [hi, lo] = get(s.of).splitByPlane(n, num(s.at, "at"));
          keep(hi); keep(lo);
          if (!lo.isEmpty()) put(ids[0], lo);
          if (!hi.isEmpty()) put(ids[1], hi);
          consumed.add(s.of);
          break;
        }
        case "lid": {              // 箱の口に合うふた。口の輪郭は「上の縁から 0.5mm 下」の断面から取る
          const box = get(s.of), bb = box.boundingBox();
          const clearance = num(s.clearance, "clearance", { min: 0, max: 5, def: 0.2 }), top = num(s.top, "top", { min: 0.2, max: 50, def: 2 });
          const depth = num(s.lip_depth, "lip_depth", { min: 0, max: 100, def: 4 }), wall = num(s.lip_wall, "lip_wall", { min: 0.2, max: 20, def: 1.5 });
          const rim = num(s.rim, "rim", { def: bb.max[2] });
          const sec = keep(box.slice(rim - 0.5));
          const rings = sec.toPolygons();
          const area = (r) => r.reduce((a, p, k) => { const q = r[(k + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
          const outer = rings.filter((r) => area(r) > 0).sort((a, b) => area(b) - area(a))[0];
          const hole = rings.filter((r) => area(r) < 0).sort((a, b) => area(a) - area(b))[0];
          if (!outer || !hole) throw new StepError("上の縁に口（穴）が見つかりません。rim で高さを指定してください");
          const plate = keep(keep(new w.CrossSection([outer], "Positive")).extrude(top).translate([0, 0, rim]));
          let m = plate;
          if (depth > 0) {
            const lipOut = keep(keep(new w.CrossSection([hole.slice().reverse()], "Positive")).offset(-clearance, "Round"));
            const lip = keep(lipOut.subtract(keep(lipOut.offset(-wall, "Round"))));
            if (!lip.isEmpty()) m = keep(m.add(keep(lip.extrude(depth).translate([0, 0, rim - depth]))));
          }
          if (s.layout === "print") {        // 印刷向き: 裏返して箱の横に置く
            const mb = m.boundingBox(), gap = num(s.gap, "gap", { min: 0, def: 5 });
            m = keep(keep(m.rotate([180, 0, 0])).translate([0, 0, 0]));
            const nb = m.boundingBox();
            m = keep(m.translate([bb.max[0] + gap - nb.min[0], 0, -nb.min[2]]));
            void mb;
          }
          put(s.id ?? "lid", m);
          break;
        }
        case "hide": for (const id of [].concat(s.of)) consumed.add(id); break;
        default: throw new StepError(`op「${op}」は使えません`);
      }
    } catch (e) {
      out.errors.push({ i, msg: e instanceof StepError ? e.message : String(e?.message || e) });
    }
  }
  out.computed = true;
  // 出す物: 元の形（計算で置き換えていない物）＋計算した物。with で使った道具は出さない
  for (const [id, geom] of sources) if (!env.has(id) && !consumed.has(id)) out.bodies.push({ id, geom, from: "source" });
  for (const id of order) {
    if (consumed.has(id)) continue;
    const m = env.get(id);
    if (m.isEmpty()) { out.errors.push({ i: -1, msg: `${id} は空になりました` }); continue; }
    out.bodies.push({ id, geom: toGeometry(m), from: sources.has(id) ? "edited" : "recipe" });
  }
  for (const m of trash) if (![...cache.values()].includes(m)) try { m.delete(); } catch { /* 済み */ }
  return out;
}

/**
 * 断面の輪郭（AI に渡す数値）。axis=at の面で切った形を 2D の多角形で返す
 * 座標: axis z → [x, y] / x → [y, z] / y → [x, z]
 */
export async function sectionPolygons(geom, axis, at, maxPts = 400) {
  const w = await manifold();
  let m;
  try { m = toManifold(w, geom); } catch { return null; }
  const rot = { z: null, x: [0, -90, 0], y: [90, 0, 0] }[axis];
  const r = rot ? m.rotate(rot) : m;
  const cs = r.slice(at);
  const rings = cs.toPolygons().map((ring) => {
    const mapped = ring.map(([u, v]) => (axis === "z" ? [u, v] : axis === "x" ? [v, -u] : [u, -v]));
    const step = Math.max(1, Math.ceil(mapped.length / maxPts));
    return mapped.filter((_, k) => k % step === 0).map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]);
  });
  const area = Math.abs(cs.area());
  cs.delete(); if (r !== m) r.delete(); m.delete();
  return { rings, area: +area.toFixed(2) };
}
