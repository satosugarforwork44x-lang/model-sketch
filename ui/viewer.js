// model/ui/viewer.js — 3D の表示（three.js）。座標は mm・Z が上（3D プリントと同じ）。描くのは変わったときだけ
import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "./vendor/addons/environments/RoomEnvironment.js";
import { MATERIALS, linear } from "./paint.js";

const raw = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
/** CSS の色（半透明でもよい）を、背景（--well）に重ねた不透明の色にする。three.js は透明度を無視するため */
function css(name, fb) {
  const light = document.documentElement.dataset.mode === "light";
  probe.fillStyle = light ? "#eef0f4" : "#15161b"; probe.fillRect(0, 0, 1, 1);      // 窓の地（--well も半透明なので、先に不透明の地を敷く）
  probe.fillStyle = raw("--well", "transparent"); probe.fillRect(0, 0, 1, 1);
  probe.fillStyle = fb; probe.fillStyle = raw(name, fb); probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
export const VIEWS = { iso: [1, -1.25, 0.95], front: [0, -1, 0.0001], right: [1, 0, 0.0001], top: [0, -0.0001, 1], back: [0, 1, 0.0001], left: [-1, 0, 0.0001] };
const OVERHANG = Math.sin(Math.PI / 4);      // 45° を超えて下を向く面

export class Viewer {
  constructor(host, { onChange } = {}) {
    this.host = host;
    this.onChange = onChange || (() => {});
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(200, -250, 190);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => this.request());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1));
    this.key = new THREE.DirectionalLight(0xffffff, 1.3);
    try {                       // 映り込み（金属・光沢が金属らしく見えるように）
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.55;
      pm.dispose();
    } catch { /* 無くても表示はできる */ }
    this.camera.add(this.key);
    this.key.position.set(0.4, 0.8, 0.2);
    this.scene.add(this.camera);
    this.floor = new THREE.Group();
    this.models = new THREE.Group();
    this.helpers = new THREE.Group();
    this.marks = new THREE.Group();
    this.scene.add(this.floor, this.models, this.helpers, this.marks);
    this.measure = [];
    this.measureEl = document.createElement("div");
    this.measureEl.className = "mo-measure";
    this.measureEl.hidden = true;
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.section = { on: false, axis: "z", at: 0, flip: false };
    this.bodies = [];          // { id, mesh, cap, geom }
    this.overhang = false;
    this.purpose = "print";
    this.bed = { w: 256, d: 256, h: 256 };
    this.pinEls = new Map();
    this.pinLayer = document.createElement("div");
    this.pinLayer.className = "mo-pins";
    host.append(this.pinLayer);
    this.pinLayer.append(this.measureEl);
    this.pins = [];
    this.activePin = null;
    this._raf = 0;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.buildFloor();
  }

  // ---------- 描く ----------
  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  render() {
    this.renderer.render(this.scene, this.camera);
    this.placePins();
    this.onChange();
  }
  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request();
  }
  dispose() {
    this.ro.disconnect();
    cancelAnimationFrame(this._raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
  themeChanged() { this.buildFloor(); this.setBodies(this.lastBodies || []); }

  // ---------- 床（プリント: プリンタの台 / ゲーム: 地面の格子） ----------
  setPurpose(p) { this.purpose = p; this.buildFloor(); this.applyColors(); this.request(); }
  setBed(b) { this.bed = b; this.buildFloor(); this.request(); }
  buildFloor() {
    for (const c of [...this.floor.children]) { c.geometry?.dispose(); c.material?.dispose(); this.floor.remove(c); }
    const minor = new THREE.Color(css("--line", "#444")), major = new THREE.Color(css("--ink-4", "#666")), edge = new THREE.Color(css("--muted", "#999"));
    const pts = [], cols = [];
    const line = (a, b, c) => { pts.push(...a, ...b); cols.push(c.r, c.g, c.b, c.r, c.g, c.b); };
    let half;
    if (this.purpose === "print") {
      const { w, d } = this.bed, x0 = -w / 2, y0 = -d / 2;
      for (let x = 0; x <= w + 1e-6; x += 10) line([x0 + x, y0, 0], [x0 + x, y0 + d, 0], x % 50 === 0 ? major : minor);
      for (let y = 0; y <= d + 1e-6; y += 10) line([x0, y0 + y, 0], [x0 + w, y0 + y, 0], y % 50 === 0 ? major : minor);
      const g = new THREE.PlaneGeometry(w, d);
      const m = new THREE.MeshBasicMaterial({ color: css("--ink-2", "#222"), transparent: true, opacity: 0.55, depthWrite: false });
      const plate = new THREE.Mesh(g, m);
      plate.position.z = -0.05;
      plate.renderOrder = -1;
      this.floor.add(plate);
      // 造形できる高さの枠（うすく）
      const h = this.bed.h;
      for (const [a, b] of [[[x0, y0], [x0 + w, y0]], [[x0 + w, y0], [x0 + w, y0 + d]], [[x0 + w, y0 + d], [x0, y0 + d]], [[x0, y0 + d], [x0, y0]]]) {
        line([...a, h], [...b, h], minor);
        line([...a, 0], [...a, h], minor);
      }
      line([x0, y0, 0], [x0 + w, y0, 0], edge);
      half = Math.max(w, d) / 2;
    } else {
      const r = Math.max(1000, Math.ceil((this.extent || 500) / 500) * 500);   // 0.5 m ごとに広げる
      for (let v = -r; v <= r + 1e-6; v += 100) {
        const c = Math.abs(v) % 1000 < 1e-6 ? major : minor;
        line([v, -r, 0], [v, r, 0], c);
        line([-r, v, 0], [r, v, 0], c);
      }
      half = r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    this.floor.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })));
    // 原点の軸（X 赤・Y 緑・Z 青）
    const a = Math.min(30, half / 4), ax = new THREE.BufferGeometry();
    ax.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.05, a, 0, 0.05, 0, 0, 0.05, 0, a, 0.05, 0, 0, 0, 0, 0, a], 3));
    ax.setAttribute("color", new THREE.Float32BufferAttribute([0.95, 0.3, 0.3, 0.95, 0.3, 0.3, 0.3, 0.8, 0.4, 0.3, 0.8, 0.4, 0.35, 0.55, 1, 0.35, 0.55, 1], 3));
    this.floor.add(new THREE.LineSegments(ax, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })));
  }

  // ---------- 形 ----------
  /** list: [{ id, geom(BufferGeometry, mm), color, hidden }] */
  setBodies(list) {
    this.lastBodies = list;
    for (const b of this.bodies) { this.models.remove(b.mesh, b.cap); b.mesh.material.dispose(); b.cap.material.dispose(); }
    this.bodies = [];
    for (const it of list) {
      const geom = it.geom;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, clippingPlanes: [this.plane], side: THREE.FrontSide });
      const mesh = new THREE.Mesh(geom, mat);
      const cap = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: this.capColor(), side: THREE.BackSide, clippingPlanes: [this.plane],
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
      mesh.userData.id = cap.userData.id = it.id;
      mesh.visible = cap.visible = !it.hidden;
      this.models.add(mesh, cap);
      this.bodies.push({ id: it.id, mesh, cap, geom, color: it.color, tri: it.triColors || null, material: it.material || "plastic" });
    }
    this.extent = this.bounds().getSize(new THREE.Vector3()).length();
    if (this.purpose === "game") this.buildFloor();
    this.applySection();
    this.applyColors();
    this.request();
  }
  baseColor() { return this.purpose === "game" ? "#c8ccd2" : css("--model", "#d4d8de"); }
  capColor() { return this.section.on ? css("--signal", "#ff9f0a") : css("--ink-4", "#555"); }   // 断面でないときの裏面 = 穴の空いた形の内側
  applyColors() {
    for (const b of this.bodies) {
      const [rough, metal] = MATERIALS[b.material] || MATERIALS.plastic;
      b.mesh.material.roughness = rough;
      b.mesh.material.metalness = metal;
      b.cap.material.color.set(this.capColor());
      this.paintVertices(b);
    }
    this.request();
  }
  /** 頂点の色 = 塗った色（無ければ部品の色）。プリントでオーバーハングを見るときは赤みを重ねる */
  paintVertices(b) {
    const geom = b.geom, pos = geom.attributes.position, n = pos.count;
    let col = geom.attributes.color;
    if (!col || col.count !== n) { col = new THREE.BufferAttribute(new Float32Array(n * 3), 3); geom.setAttribute("color", col); }
    const arr = col.array, base = linear(b.color || this.baseColor()), tri = b.tri;
    for (let t = 0; t < n / 3; t++) {
      const c = (tri && tri[t] && linear(tri[t])) || base;
      for (let k = 0; k < 3; k++) { const i = (t * 3 + k) * 3; arr[i] = c[0]; arr[i + 1] = c[1]; arr[i + 2] = c[2]; }
    }
    if (this.overhang && this.purpose === "print" && !geom.index) {
      geom.computeBoundingBox();
      const z0 = geom.boundingBox.min.z + 0.05, a = new THREE.Vector3(), bb = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
      for (let i = 0; i < n; i += 3) {
        a.fromBufferAttribute(pos, i); bb.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        nn.subVectors(c, bb).cross(a.clone().sub(bb)).normalize();
        if (nn.z < -OVERHANG && Math.max(a.z, bb.z, c.z) > z0) for (let k = 0; k < 3; k++) { const j = (i + k) * 3; arr[j] = 0.95; arr[j + 1] = 0.25; arr[j + 2] = 0.1; }
      }
    }
    col.needsUpdate = true;
  }
  /** 筆で塗っている途中の見た目（保存はしない） */
  previewTris(id, tris, hex) {
    const b = this.bodies.find((x) => x.id === id);
    if (!b) return;
    const arr = b.geom.attributes.color.array, c = linear(hex || b.color || this.baseColor());
    for (const t of tris) for (let k = 0; k < 3; k++) { const i = (t * 3 + k) * 3; arr[i] = c[0]; arr[i + 1] = c[1]; arr[i + 2] = c[2]; }
    b.geom.attributes.color.needsUpdate = true;
    this.request();
  }
  setHidden(id, hidden) {
    for (const b of this.bodies) if (b.id === id) b.mesh.visible = b.cap.visible = !hidden;
    this.applySection();
    this.request();
  }
  setOverhang(on) { this.overhang = on; this.applyColors(); }
  bounds(onlyVisible = true) {
    const box = new THREE.Box3();
    for (const b of this.bodies) if (!onlyVisible || b.mesh.visible) { b.geom.computeBoundingBox(); box.union(b.geom.boundingBox); }
    return box;
  }

  // ---------- 断面 ----------
  setSection(s) {
    const was = this.section.on;
    this.section = { ...this.section, ...s };
    if (was !== this.section.on) for (const b of this.bodies) b.cap.material.color.set(this.capColor());
    this.applySection();
    this.request();
  }
  applySection() {
    const s = this.section, keep = { x: -1, y: 1, z: -1 }[s.axis] * (s.flip ? -1 : 1);   // 残す側（既定の視点から切り口が見える向き）
    const n = AXES[s.axis].clone().multiplyScalar(keep);
    if (s.on) this.plane.set(n, -keep * s.at);
    else this.plane.set(new THREE.Vector3(0, 0, -1), 1e9);
    for (const c of [...this.helpers.children]) { c.geometry?.dispose(); c.material?.dispose(); this.helpers.remove(c); }
    if (!s.on) return;
    // 切り口の線（見えている形と面の交わり）
    const pts = [];
    for (const b of this.bodies) if (b.mesh.visible) sliceSegments(b.geom, s.axis, s.at, pts);
    if (pts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: css("--text", "#fff"), depthTest: false, transparent: true, opacity: 0.9 }));
      line.renderOrder = 5;
      this.helpers.add(line);
    }
    // 切る面のうすい板
    const box = this.bounds(), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const pad = 1.12;
    const dims = { x: [size.y, size.z], y: [size.x, size.z], z: [size.x, size.y] }[s.axis];
    const g = new THREE.PlaneGeometry(Math.max(1, dims[0] * pad), Math.max(1, dims[1] * pad));
    const m = new THREE.MeshBasicMaterial({ color: this.capColor(), transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
    const p = new THREE.Mesh(g, m);
    if (s.axis === "x") { p.rotation.set(0, Math.PI / 2, 0); p.position.set(s.at, c.y, c.z); }
    else if (s.axis === "y") { p.rotation.set(Math.PI / 2, 0, 0); p.position.set(c.x, s.at, c.z); }
    else p.position.set(c.x, c.y, s.at);
    this.helpers.add(p);
  }

  // ---------- 視点 ----------
  fit(view = "iso", animate = false) {
    const box = this.bounds();
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(5, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = new THREE.Vector3(...(VIEWS[view] || VIEWS.iso)).normalize();
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.08 / Math.min(1, this.camera.aspect * 0.9 + 0.1);
    this.camera.near = Math.max(0.05, dist / 1000);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    const to = c.clone().add(dir.multiplyScalar(dist));
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.camera.position.copy(to);
      this.controls.target.copy(c);
      this.controls.update();
      return;
    }
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone(), start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 260), e = 1 - (1 - k) ** 3;
      this.camera.position.lerpVectors(p0, to, e);
      this.controls.target.lerpVectors(t0, c, e);
      this.controls.update();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- 指す ----------
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(v, this.camera);
    const meshes = this.bodies.filter((b) => b.mesh.visible).map((b) => b.mesh);
    for (const hit of ray.intersectObjects(meshes, false)) {
      if (this.section.on && this.plane.distanceToPoint(hit.point) < -1e-4) continue;    // 切って隠れている所は指せない
      const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
      return { p: hit.point.toArray(), n: n.toArray(), part: hit.object.userData.id, tri: hit.faceIndex ?? -1 };
    }
    return null;
  }
  setPins(pins, active = null) { this.pins = pins || []; this.activePin = active; this.placePins(); }
  placePins() {
    const r = this.host.getBoundingClientRect(), seen = new Set(), v = new THREE.Vector3(), camDir = new THREE.Vector3();
    for (const p of this.pins) {
      seen.add(p.id);
      let el = this.pinEls.get(p.id);
      if (!el) {
        el = document.createElement("button");
        el.className = "mo-pin";
        el.dataset.id = p.id;
        this.pinLayer.append(el);
        this.pinEls.set(p.id, el);
      }
      el.textContent = p.id;
      v.set(...p.p).project(this.camera);
      const hidden = v.z > 1 || (this.section.on && this.plane.distanceToPoint(new THREE.Vector3(...p.p)) < -1e-3);
      camDir.set(...p.p).sub(this.camera.position);
      el.classList.toggle("back", camDir.dot(new THREE.Vector3(...p.n)) > 0);
      el.classList.toggle("on", p.id === this.activePin);
      el.hidden = hidden;
      el.title = p.text || "";
      el.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px)`;
    }
    for (const [id, el] of this.pinEls) if (!seen.has(id)) { el.remove(); this.pinEls.delete(id); }
    const me = this.measureEl;
    me.hidden = this.measure.length !== 2;
    if (!me.hidden) {
      const [a, b] = this.measure.map((p) => new THREE.Vector3(...p));
      v.addVectors(a, b).multiplyScalar(0.5).project(this.camera);
      me.textContent = `${a.distanceTo(b).toFixed(2)} mm`;
      me.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px)`;
    }
  }

  // ---------- 測る（2 点） ----------
  setMeasure(pts) {
    this.measure = pts || [];
    for (const c of [...this.marks.children]) { c.geometry?.dispose(); c.material?.dispose(); this.marks.remove(c); }
    const col = css("--signal", "#ff9f0a"), r = Math.max(0.4, (this.extent || 100) / 250);
    for (const p of this.measure) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
      m.position.set(...p);
      m.renderOrder = 6;
      this.marks.add(m);
    }
    if (this.measure.length === 2) {
      const g = new THREE.BufferGeometry().setFromPoints(this.measure.map((p) => new THREE.Vector3(...p)));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, depthTest: false }));
      l.renderOrder = 6;
      this.marks.add(l);
    }
    this.request();
  }

  // ---------- 画像（AI 用・一覧用） ----------
  /** 指定した視点で描いた画像を返す（画面の表示は元に戻す） */
  shot(view, w, h, { bg = null, pins = true, floor = false } = {}) {
    const keep = { pos: this.camera.position.clone(), tgt: this.controls.target.clone(), aspect: this.camera.aspect,
      size: this.renderer.getSize(new THREE.Vector2()), ratio: this.renderer.getPixelRatio(), near: this.camera.near, far: this.camera.far };
    const floorWas = this.floor.visible;
    this.floor.visible = floor;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fit(view);
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const g = out.getContext("2d");
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.drawImage(this.renderer.domElement, 0, 0, w, h);
    if (pins) {
      const v = new THREE.Vector3();
      for (const p of this.pins) {
        if (this.section.on && this.plane.distanceToPoint(new THREE.Vector3(...p.p)) < -1e-3) continue;
        v.set(...p.p).project(this.camera);
        if (v.z > 1) continue;
        const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h, rr = Math.max(9, w / 48);
        g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2);
        g.fillStyle = "#FFD60A"; g.fill(); g.lineWidth = 2; g.strokeStyle = "#111"; g.stroke();
        g.fillStyle = "#111"; g.font = `700 ${Math.round(rr * 1.15)}px "Segoe UI", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String(p.id), x, y + 0.5);
      }
    }
    this.floor.visible = floorWas;
    this.renderer.setPixelRatio(keep.ratio);
    this.renderer.setSize(keep.size.x, keep.size.y, false);
    this.camera.aspect = keep.aspect;
    this.camera.near = keep.near; this.camera.far = keep.far;
    this.camera.position.copy(keep.pos);
    this.controls.target.copy(keep.tgt);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
    return out;
  }
}

/** 面と平面（axis = at）の交わりの線分を pts に足す（どんな形でも使える。閉じていなくてもよい） */
export function sliceSegments(geom, axis, at, pts, limit = 400000) {
  const pos = geom.attributes.position, idx = geom.index, k = { x: 0, y: 1, z: 2 }[axis];
  const tri = idx ? idx.count / 3 : pos.count / 3, a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  const get = (i, o) => { o[0] = pos.getX(i); o[1] = pos.getY(i); o[2] = pos.getZ(i); return o; };
  for (let t = 0; t < tri && pts.length < limit; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    get(i0, a); get(i1, b); get(i2, c);
    const da = a[k] - at, db = b[k] - at, dc = c[k] - at;
    if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
    const hit = [];
    for (const [p, q, dp, dq] of [[a, b, da, db], [b, c, db, dc], [c, a, dc, da]]) {
      if ((dp <= 0 && dq > 0) || (dp > 0 && dq <= 0)) {
        const s = dp / (dp - dq);
        hit.push(p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s);
      }
    }
    if (hit.length === 6) pts.push(...hit);
  }
  return pts;
}
