// model/ui/paint.js — 面に色を塗る。塗った結果は「どこを・何色に」の手順（doc.paint）で持ち、形を計算し直すたびに当て直す
// ・形は三角形ごと（loaders.js / recipe.js の出力）。色は三角形ごとに持つ
// where（どこを）:
//   なし                                … 部品全体
//   { face: { p:[x,y,z], n:[x,y,z] } } … p の面から、つながった平らな面（角度 tol 度以内、既定 12）
//   { normal: "up"|"down"|"side"|[x,y,z], angle: 30 } … その向きを向いた面
//   { box: [[x0,y0,z0],[x1,y1,z1]] }   … 三角形の中心が箱の中
//   { points: [[x,y,z],…], radius: 3 } … 筆（点から radius 以内に掛かる三角形）
import * as THREE from "./vendor/three.module.js";

export const HEX = /^#[0-9A-Fa-f]{6}$/;
const DIRS = { up: [0, 0, 1], down: [0, 0, -1] };
const adjCache = new WeakMap(), infoCache = new WeakMap();

/** 三角形ごとの中心と向き（キャッシュ） */
function info(geom) {
  let r = infoCache.get(geom);
  if (r) return r;
  const p = geom.attributes.position.array, n = p.length / 9;
  const c = new Float32Array(n * 3), nr = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    c[t * 3] = (p[o] + p[o + 3] + p[o + 6]) / 3; c[t * 3 + 1] = (p[o + 1] + p[o + 4] + p[o + 7]) / 3; c[t * 3 + 2] = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2], wx = p[o + 6] - p[o], wy = p[o + 7] - p[o + 1], wz = p[o + 8] - p[o + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx, l = Math.hypot(x, y, z) || 1;
    nr[t * 3] = x / l; nr[t * 3 + 1] = y / l; nr[t * 3 + 2] = z / l;
  }
  r = { c, n: nr, count: n };
  infoCache.set(geom, r);
  return r;
}

/** 辺でつながった三角形（頂点の位置を丸めて同じ点とみなす） */
function adjacency(geom) {
  let a = adjCache.get(geom);
  if (a) return a;
  const p = geom.attributes.position.array, n = p.length / 9, ids = new Map(), vid = new Uint32Array(n * 3);
  const key = (i) => `${Math.round(p[i] * 1e4)},${Math.round(p[i + 1] * 1e4)},${Math.round(p[i + 2] * 1e4)}`;
  for (let v = 0; v < n * 3; v++) {
    const k = key(v * 3);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    vid[v] = id;
  }
  const edges = new Map();
  for (let t = 0; t < n; t++) for (let e = 0; e < 3; e++) {
    const x = vid[t * 3 + e], y = vid[t * 3 + ((e + 1) % 3)], k = x < y ? x * 4294967296 + y : y * 4294967296 + x;
    const l = edges.get(k);
    if (l) l.push(t); else edges.set(k, [t]);
  }
  const nb = Array.from({ length: n }, () => []);
  for (const l of edges.values()) for (const t of l) for (const u of l) if (t !== u) nb[t].push(u);
  a = nb;
  adjCache.set(geom, a);
  return a;
}

/** 点 p に一番近い三角形（向き n に近いものを優先） */
export function nearestTri(geom, p, n) {
  const { c, n: nr, count } = info(geom);
  let best = -1, bd = Infinity;
  for (let t = 0; t < count; t++) {
    const d = (c[t * 3] - p[0]) ** 2 + (c[t * 3 + 1] - p[1]) ** 2 + (c[t * 3 + 2] - p[2]) ** 2;
    const facing = n ? nr[t * 3] * n[0] + nr[t * 3 + 1] * n[1] + nr[t * 3 + 2] * n[2] : 1;
    const score = d + (facing < 0.9 ? 1e6 : 0);
    if (score < bd) { bd = score; best = t; }
  }
  return best;
}

/** t からつながった平らな面（隣との角度が tol 度以内、かつ始めの面との角度が tol*2 以内） */
export function flatRegion(geom, t, tol = 12) {
  const { n } = info(geom), nb = adjacency(geom), cs = Math.cos((tol * Math.PI) / 180), cs2 = Math.cos((Math.min(89, tol * 2) * Math.PI) / 180);
  const seen = new Set([t]), stack = [t];
  while (stack.length) {
    const a = stack.pop();
    for (const b of nb[a]) {
      if (seen.has(b)) continue;
      const d = n[a * 3] * n[b * 3] + n[a * 3 + 1] * n[b * 3 + 1] + n[a * 3 + 2] * n[b * 3 + 2];
      const d0 = n[t * 3] * n[b * 3] + n[t * 3 + 1] * n[b * 3 + 1] + n[t * 3 + 2] * n[b * 3 + 2];
      if (d >= cs && d0 >= cs2) { seen.add(b); stack.push(b); }
    }
  }
  return [...seen];
}

/** where に当たる三角形の番号 */
export function select(geom, where) {
  const { c, n, count } = info(geom), out = [];
  if (!where || typeof where !== "object" || !Object.keys(where).length) { for (let t = 0; t < count; t++) out.push(t); return out; }
  if (where.face) {
    const p = where.face.p, d = where.face.n;
    if (!Array.isArray(p) || p.length !== 3) return out;
    const t = nearestTri(geom, p.map(Number), Array.isArray(d) && d.length === 3 ? d.map(Number) : null);
    return t < 0 ? out : flatRegion(geom, t, Number(where.tol) || 12);
  }
  if (where.normal) {
    let d = DIRS[where.normal] || (Array.isArray(where.normal) ? where.normal.map(Number) : null);
    const side = where.normal === "side";
    const cs = Math.cos(((Number(where.angle) || 30) * Math.PI) / 180);
    if (d) { const l = Math.hypot(...d) || 1; d = d.map((v) => v / l); }
    for (let t = 0; t < count; t++) {
      const z = n[t * 3 + 2];
      if (side ? Math.abs(z) <= Math.sin(((Number(where.angle) || 30) * Math.PI) / 180) : d && n[t * 3] * d[0] + n[t * 3 + 1] * d[1] + z * d[2] >= cs) out.push(t);
    }
    return out;
  }
  if (where.box) {
    const [a, b] = where.box, lo = a.map((v, i) => Math.min(v, b[i])), hi = a.map((v, i) => Math.max(v, b[i]));
    for (let t = 0; t < count; t++) {
      const x = c[t * 3], y = c[t * 3 + 1], z = c[t * 3 + 2];
      if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]) out.push(t);
    }
    return out;
  }
  if (Array.isArray(where.points) && where.points.length) {     // 筆: 筆先から三角形までの距離（大きな三角形のローポリでも塗れる）
    const r = Math.max(0.01, Number(where.radius) || 2), r2 = r * r, pts = where.points.map((q) => new THREE.Vector3(+q[0], +q[1], +q[2]));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const q of pts) { const a = q.toArray(); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a[i] - r); hi[i] = Math.max(hi[i], a[i] + r); } }
    const P = geom.attributes.position.array, tri = new THREE.Triangle(), cp = new THREE.Vector3();
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      if (Math.max(P[o], P[o + 3], P[o + 6]) < lo[0] || Math.min(P[o], P[o + 3], P[o + 6]) > hi[0] ||
          Math.max(P[o + 1], P[o + 4], P[o + 7]) < lo[1] || Math.min(P[o + 1], P[o + 4], P[o + 7]) > hi[1] ||
          Math.max(P[o + 2], P[o + 5], P[o + 8]) < lo[2] || Math.min(P[o + 2], P[o + 5], P[o + 8]) > hi[2]) continue;
      tri.a.set(P[o], P[o + 1], P[o + 2]); tri.b.set(P[o + 3], P[o + 4], P[o + 5]); tri.c.set(P[o + 6], P[o + 7], P[o + 8]);
      for (const q of pts) if (tri.closestPointToPoint(q, cp).distanceToSquared(q) <= r2) { out.push(t); break; }
    }
  }
  return out;
}

/**
 * 部品 id の三角形ごとの色（hex の配列。null は部品の色のまま）を返す。塗りが無ければ null
 * ops: doc.paint（上から順に。後の手順が上書き）
 */
export function paintColors(id, geom, ops) {
  const mine = (ops || []).filter((o) => o && (!o.of || o.of === id || (Array.isArray(o.of) && o.of.includes(id))));
  if (!mine.length) return null;
  const cols = new Array(info(geom).count).fill(null);
  for (const o of mine) {
    const col = o.color === null || HEX.test(o.color || "") ? o.color : undefined;
    if (col === undefined) continue;
    for (const t of select(geom, o.where)) cols[t] = col;
  }
  return cols.some((v) => v) ? cols : null;
}

/** 色の文字列 → 線形の RGB（three.js の頂点の色・テクスチャ用） */
const cache = new Map();
export function linear(hex) {
  let c = cache.get(hex);
  if (!c) { const k = new THREE.Color(hex); c = [k.r, k.g, k.b]; cache.set(hex, c); }
  return c;
}

/** 材質の種類 → 粗さ・金属らしさ */
export const MATERIALS = { plastic: [0.5, 0], matte: [0.95, 0], gloss: [0.15, 0], metal: [0.32, 1] };
