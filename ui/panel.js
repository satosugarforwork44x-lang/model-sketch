// model/ui/panel.js — モデルスケッチ。3D を見て・切って・ピンで指し、Claude にレシピで形を足してもらう
// ・データは「Model Sketch」フォルダの <名前>.model.json。外（Claude など）で書き換えられたら読み直して計算し直す
// ・座標は mm・Z が上・元の形は「底の中心が原点」。ゲーム用の書き出し（GLB）だけ m・Y が上に直す
import { TOKEN, selectBox } from "/ui/js/hub.js";
import { icons } from "/ui/js/icons.js";
import { Viewer } from "./viewer.js";
import { loadModel, triCount, volumeOf } from "./loaders.js";
import { manifold, runRecipe, sectionPolygons } from "./recipe.js";
import { to3MF, toGLB, toSTL } from "./export.js";
import { HEX, paintColors, select } from "./paint.js";

const EN = (document.documentElement.lang || navigator.language || "ja").startsWith("en");
const L = EN ? {
  title: "Model Sketch", dropTitle: "Drop a 3D file here", dropNote: "STL · 3MF · OBJ · GLB. The original file is never changed.",
  pick: "Choose a file…", blank: "Start empty (make it with Claude)", recent: "Recent", empty: "No model sketches yet", openFolder: "Open the folder",
  home: "All model sketches", undo: "Undo (Ctrl+Z)", redo: "Redo (Ctrl+Y)", loading: "Loading…", computing: "Computing…",
  missing: "The original file was not found:", relink: "Locate…", unreadable: "This file could not be read.",
  reloaded: "Reloaded (changed outside)", warn: "Some parts were skipped", skipped: (s) => `Skipped: ${s}`,
  purpose: { print: "3D print", game: "Game" },
  tools: { V: "Rotate / select", P: "Pin", B: "Paint", M: "Measure", S: "Section" },
  hints: { V: "Drag = rotate · right-drag = move · wheel = zoom · F = fit · 1 3 7 0 = front / right / top / angled",
    P: "Click on the model to place a pin, then write what to change on the right",
    B: "Click to paint · Alt + click = pick a color · drag empty space = rotate", M: "Click two points to measure · Esc = clear",
    S: "Move the slider on the right (or Shift + wheel) to move the cut" },
  views: { iso: "Angled (0)", front: "Front (1)", right: "Right (3)", top: "Top (7)", fit: "Fit (F)" },
  parts: "Parts", from: { source: "file", recipe: "recipe", edited: "edited" }, hide: "Hide", show: "Show", color: "Color", tris: (n) => `${n.toLocaleString()} tris`,
  section: "Section", axis: "Axis", flip: "Show the other side", cutOn: "Cut and look inside", sectionArea: (a) => `Cut area ${a} mm²`,
  pins: "Pins", noPins: "No pins yet. Press P and click where you want a change.", pinPh: "e.g. Make this wall 2 mm thicker", delPin: "Delete pin",
  params: "Values", recipe: "Recipe", steps: (n) => `${n} steps`, noSteps: "No recipe yet. Send it to Claude and ask for a lid, holes…",
  stepErr: (i, m) => (i < 0 ? m : `Step ${i + 1}: ${m}`), notClosed: "The original shape is not closed, so it cannot be edited (viewing, sections and pins still work).",
  setup: { print: "Printer", game: "Game" }, bed: "Bed", custom: "Custom", overhang: "Show overhangs (over 45°)",
  scale: "Scale", height: "Height", glbUnit: "GLB files are in meters; shown ×1000 as mm.",
  info: "Info", file: "File", size: "Size", volume: "Volume", triangles: "Triangles", origin: "Origin", originV: "bottom center",
  fits: "Fits the bed", tooBig: "Larger than the bed", sendAI: "Send to AI",
  sendTip: "Saves 4 views with pin numbers and the measurements (sizes, section outlines) for Claude, and copies a request.",
  sent: "Request copied. Paste it to Claude (the Hub connection lets Claude read this folder).", aiSaved: "AI files updated",
  prompt: (n, pins) => `Please edit the Hub Model Sketch "${n}". First read MODEL_FORMAT.md in the Model Sketch folder, then look at ${n}.model.json, _ai/${n}.json and _ai/${n}.png, and rewrite "steps" (and "params") so that:\n${pins}\nKeep the original file as it is.`,
  noPinText: "(no notes)", export: "Export", exportTip: "Export (Ctrl+E)", exported: (f) => `Saved ${f}`, exporting: "Exporting…",
  ex: { stl: "STL (all in one)", stlEach: "STL (one file per part)", "3mf": "3MF (parts as objects)", glb: "GLB (game: m, Y up)" },
  nothing: "Nothing to export (all parts are hidden)", pinHere: "Pin here", hidePart: "Hide this part", cutHere: "Section here",
  measure: (d) => `${d} mm`, note: "Note from Claude",
  paint: "Paint", pmode: { face: "Flat face", brush: "Brush", part: "Part" }, eraser: "Eraser (back to the part color)", custom: "Pick any color",
  brushSize: "Brush size", clearPaint: "Remove all paint", painted: "painted", material: "Material",
  mats: { plastic: "Plastic", matte: "Matte", gloss: "Glossy", metal: "Metal" },
  paintHint: "Painted colors are exported to GLB as a small palette image (works with ordinary materials in Unity, Godot and three.js).",
} : {
  title: "モデルスケッチ", dropTitle: "3D のファイルをここに落としてください", dropNote: "STL・3MF・OBJ・GLB。元のファイルは変えません",
  pick: "ファイルを選ぶ…", blank: "空から始める（Claude と作る）", recent: "最近のモデルスケッチ", empty: "まだありません", openFolder: "フォルダを開く",
  home: "一覧に戻る", undo: "元に戻す（Ctrl+Z）", redo: "やり直す（Ctrl+Y）", loading: "読み込み中…", computing: "計算中…",
  missing: "元のファイルが見つかりません:", relink: "場所を指定…", unreadable: "このファイルは読めませんでした。",
  reloaded: "外で書き換えられたので読み直しました", warn: "読み飛ばした所があります", skipped: (s) => `開けなかったもの: ${s}`,
  purpose: { print: "3D プリント", game: "ゲーム" },
  tools: { V: "回す・選ぶ", P: "ピン", B: "塗る", M: "測る", S: "断面" },
  hints: { V: "ドラッグ = 回す ・ 右ドラッグ = 動かす ・ ホイール = 寄る ・ F = 全体 ・ 1 3 7 0 = 前・右・上・斜め",
    P: "形の上をクリックしてピンを置き、右の欄に直してほしいことを書く",
    B: "クリックで塗る ・ Alt + クリック = その色を拾う ・ 何も無い所をドラッグ = 回す", M: "2 点をクリックして測る ・ Esc で消す",
    S: "右のスライダー（または Shift + ホイール）で切る位置を動かす" },
  views: { iso: "斜め（0）", front: "前（1）", right: "右（3）", top: "上（7）", fit: "全体（F）" },
  parts: "部品", from: { source: "元", recipe: "レシピ", edited: "加工" }, hide: "隠す", show: "見せる", color: "色", tris: (n) => `${n.toLocaleString()} 面`,
  section: "断面", axis: "軸", flip: "反対側を見る", cutOn: "切って中を見る", sectionArea: (a) => `切り口の面積 ${a} mm²`,
  pins: "ピン", noPins: "まだありません。P を押して、直してほしい所をクリックしてください。", pinPh: "例: この壁を 2mm 厚く", delPin: "ピンを消す",
  params: "数値", recipe: "レシピ", steps: (n) => `手順 ${n} 個`, noSteps: "レシピはまだありません。「AI に渡す」で Claude に、ふた・穴などを頼めます。",
  stepErr: (i, m) => (i < 0 ? m : `手順 ${i + 1}: ${m}`), notClosed: "元の形が閉じていないため、加工できません（表示・断面・ピンは使えます）。",
  setup: { print: "プリンタ", game: "ゲーム" }, bed: "台の大きさ", custom: "自分で入れる", overhang: "オーバーハング（45° 超）を色で見る",
  scale: "倍率", height: "高さ", glbUnit: "GLB の単位はメートルなので、1000 倍して mm で表示しています。",
  info: "情報", file: "ファイル", size: "寸法", volume: "体積", triangles: "三角形", origin: "原点", originV: "底の中心",
  fits: "台に収まります", tooBig: "台より大きい", sendAI: "AI に渡す",
  sendTip: "4 方向の画像（ピンの番号入り）と、寸法・断面の輪郭の数値を Claude 用に保存し、頼む文をコピーします。",
  sent: "頼む文をコピーしました。Claude に貼ってください（Hub の連携で、このフォルダを読めます）", aiSaved: "AI 用のファイルを更新しました",
  prompt: (n, pins) => `Hub のモデルスケッチ「${n}」を直してください。先に Model Sketch フォルダの MODEL_FORMAT.md を読み、${n}.model.json・_ai/${n}.json・_ai/${n}.png を見て、次のとおりになるように "steps"（と "params"）を書き換えてください。\n${pins}\n元のファイルはそのままにしてください。`,
  noPinText: "（メモなし）", export: "書き出し", exportTip: "書き出し（Ctrl+E）", exported: (f) => `${f} を保存しました`, exporting: "書き出しています…",
  ex: { stl: "STL（全部を 1 つに）", stlEach: "STL（部品ごとに 1 つ）", "3mf": "3MF（部品ごとの物体）", glb: "GLB（ゲーム用: m・Y が上）" },
  nothing: "書き出す物がありません（部品がすべて隠れています）", pinHere: "ここにピン", hidePart: "この部品を隠す", cutHere: "ここで断面",
  measure: (d) => `${d} mm`, note: "Claude からのひとこと",
  paint: "塗る", pmode: { face: "平らな面", brush: "筆", part: "部品ごと" }, eraser: "消しゴム（部品の色に戻す）", custom: "好きな色を選ぶ",
  brushSize: "筆の大きさ", clearPaint: "塗りを全部消す", painted: "塗りあり", material: "材質",
  mats: { plastic: "プラスチック", matte: "つや消し", gloss: "光沢", metal: "金属" },
  paintHint: "塗った色は、GLB では小さなパレット画像として書き出します（Unity・Godot・three.js の普通の材質で色が出ます）。",
};

const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  V: icons.orbit3d || svg('<circle cx="12" cy="12" r="3"/><path d="M3 12a9 4 0 0 0 18 0M12 3a4 9 0 0 1 0 18"/>'),
  P: icons.pin || svg('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'),
  B: svg('<path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z"/><path d="M8.5 13c-2 0-3.5 1.6-3.5 3.5 0 1.4-.8 2.6-2 3 1 .9 2.4 1.5 4 1.5 2.8 0 5-2.2 5-5 0-.4 0-.8-.1-1.1z"/>'),
  eraser: svg('<path d="m14 4 6 6-9 9H6l-3-3z"/><path d="M8 20h12"/>'),
  M: svg('<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>'),
  S: svg('<path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M3 12h18" stroke-dasharray="2 2"/>'),
  back: icons.left, undo: icons.undo, folder: icons.folder, cube: icons.cube, eye: icons.eye, eyeOff: icons.eyeOff, trash: icons.trash,
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  export: svg('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>'),
  ai: icons.wand || svg('<path d="m4 20 10-10M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  flip: svg('<path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4"/>'),
};
const TOOLS = ["V", "P", "B", "M", "S"];
const PALETTE = ["#F4F1EA", "#C8CCD2", "#7A808A", "#2E3238", "#8B5A2B", "#C8A27A", "#E5534B", "#F0883E",
  "#E3B341", "#9BC53D", "#57AB5A", "#2E8B57", "#56B6C2", "#539BF5", "#3B5BDB", "#B083F0"];
const BEDS = [
  ["a1mini", "Bambu Lab A1 mini", 180, 180, 180], ["a1", "Bambu Lab A1 / P1S / X1C", 256, 256, 256],
  ["mk4", "Prusa MK4 / Core One", 250, 210, 220], ["mini", "Prusa MINI", 180, 180, 180],
  ["ender3v3", "Creality Ender-3 V3", 220, 220, 250], ["kobra3", "Anycubic Kobra 3", 250, 250, 260], ["custom", null, 200, 200, 200],
];
const SWATCHES = ["#C8CCD2", "#6E7681", "#E5534B", "#F0883E", "#E3B341", "#57AB5A", "#539BF5", "#B083F0", "#8D6E63", "#F5F5F5"];
const fmt = (v, d = 1) => (Math.abs(v) < 1e-9 ? "0" : v.toFixed(d));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`model.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`model.${k}`, JSON.stringify(v)); } catch { /* 無くても動く */ } },
};

export async function mount(el, ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./model.css", import.meta.url).href;
  document.head.append(link);

  let st = null, name = null, doc = null, mtime = null;
  let src = null;                 // { key, ext, scale, upY, parts, offset, error }
  let bodies = [];                // 今見せている形 [{ id, geom, from }]
  let errors = [];
  const cache = new Map();        // 元の形 → Manifold（計算に使った物）
  let recipeKey = "";
  let tool = "V", activePin = null, measure = [];
  let pmode = store.get("pmode", "face"), pcolor = store.get("pcolor", "#E5534B"), brushPct = store.get("brush", 4);
  let bed = store.get("bed", { preset: "a1", w: 256, d: 256, h: 256 });
  let overhang = store.get("overhang", false);
  const undo = [], redo = [];

  el.innerHTML = `<div class="mo"><div class="mo-home" hidden></div><div class="mo-edit" hidden>
    <div class="mo-rail"></div>
    <div class="mo-stage"><div class="mo-gl"></div>
      <div class="mo-top"><div class="seg mo-purpose" role="radiogroup"></div></div>
      <div class="mo-views"></div>
      <div class="mo-dims"></div>
      <div class="mo-msg" hidden></div>
    </div>
    <aside class="mo-side"></aside>
  </div></div>`;
  const home = el.querySelector(".mo-home"), edit = el.querySelector(".mo-edit"), stage = el.querySelector(".mo-stage");
  const msg = el.querySelector(".mo-msg"), side = el.querySelector(".mo-side"), dims = el.querySelector(".mo-dims");
  const viewer = new Viewer(el.querySelector(".mo-gl"));
  viewer.setBed(bed);
  new MutationObserver(() => viewer.themeChanged()).observe(document.documentElement, { attributes: true });

  // ---------- 見出しのボタン ----------
  const backBtn = ctx.addTool(IC.back, L.home, () => { save(); refresh().then(showHome); });
  document.querySelector("#tools")?.prepend(backBtn);
  const undoBtn = ctx.addTool(IC.undo, L.undo, () => doUndo());
  const redoBtn = ctx.addTool(IC.redo, L.redo, () => doRedo());
  const aiBtn = ctx.addTool(IC.ai, `${L.sendAI} — ${L.sendTip}`, () => sendAI());
  const exportBtn = ctx.addTool(IC.export, L.exportTip, (e) => openExport(e));
  ctx.addTool(IC.folder, L.openFolder, () => ctx.call("reveal").catch((e) => ctx.toast(e.message, "error")));
  const editBtns = [backBtn, undoBtn, redoBtn, aiBtn, exportBtn];

  // ---------- 一覧 ----------
  function showHome() {
    name = null; doc = null; src = null; bodies = [];
    viewer.setBodies([]); viewer.setPins([]);
    edit.hidden = true; home.hidden = false;
    for (const b of editBtns) b.style.display = "none";
    ctx.setTitle(L.title);
    ctx.setStatus("");
    home.innerHTML = `<div class="mo-drop">${IC.cube}<p class="t"></p><p class="n"></p><div class="row"><button class="btn primary pick"></button><button class="btn blank"></button></div></div>
      <h3 class="mo-h"></h3><div class="mo-grid"></div>`;
    home.querySelector(".t").textContent = L.dropTitle;
    home.querySelector(".n").textContent = L.dropNote;
    const pick = home.querySelector(".pick");
    pick.textContent = L.pick;
    pick.addEventListener("click", async () => {
      const paths = await ctx.host.pickFiles(ctx.id).catch(() => null);
      if (paths?.length) addFiles(paths);
    });
    const blank = home.querySelector(".blank");
    blank.textContent = L.blank;
    blank.addEventListener("click", async () => {
      try { const r = await ctx.call("new_model", { purpose: store.get("purpose", "print"), name: EN ? "New model" : "新しいモデル" }); await refresh(); await open(r.name); }
      catch (e) { ctx.toast(e.message, "error"); }
    });
    home.querySelector(".mo-h").textContent = L.recent;
    const grid = home.querySelector(".mo-grid");
    if (!st.files.length) { grid.innerHTML = `<p class="mo-none"></p>`; grid.firstChild.textContent = L.empty; }
    for (const f of st.files) {
      const b = document.createElement("button");
      b.className = "mo-card";
      b.innerHTML = `<span class="thumb">${IC.cube}<img alt="" loading="lazy"></span><span class="nm"></span>`;
      const im = b.querySelector("img");
      im.src = `/blob/model/thumb-${encodeURIComponent(f)}?t=${encodeURIComponent(TOKEN)}&v=${Date.now() % 1e6}`;
      im.addEventListener("error", () => im.remove());
      b.querySelector(".nm").textContent = f;
      b.addEventListener("click", () => open(f));
      grid.append(b);
    }
  }
  async function refresh() { st = await ctx.call("state"); }
  async function addFiles(paths) {
    try {
      const r = await ctx.call("add_files", { paths });
      if (r.skipped.length) ctx.toast(L.skipped(r.skipped.join(", ")), "error", 6000);
      await refresh();
      if (r.made.length) await open(r.made.at(-1));
      else if (!name) showHome();
    } catch (e) { ctx.toast(e.message, "error"); }
  }
  ctx.onNativeDrop((paths) => { if (paths?.length) addFiles(paths); });

  // ---------- 開く・読む・計算 ----------
  async function open(n, quiet = false) {
    try {
      const r = await ctx.call("open_model", { name: n });
      if (quiet && doc) pushUndo();
      else if (name !== n) { undo.length = 0; redo.length = 0; activePin = null; measure = []; viewer.setMeasure?.([]); }
      const first = name !== n;
      name = r.name; doc = r.doc; mtime = r.mtime;
      if (r.warnings?.length) ctx.toast(`${L.warn}: ${r.warnings[0]}`, "error", 6000);
      else if (quiet) ctx.toast(L.reloaded);
      home.hidden = true; edit.hidden = false;
      for (const b of editBtns) b.style.display = "";
      ctx.setTitle(n);
      store.set("purpose", doc.purpose);
      buildRail(); buildTop();
      viewer.setPurpose(doc.purpose);
      await loadSource(r, first);
      await rebuild(first);
      if (quiet) scheduleAI(true);
    } catch (e) { ctx.toast(e.message, "error"); }
  }
  async function loadSource(r, force) {
    const s = doc.source;
    if (!s) { dropCache(); src = { parts: [] }; return; }
    const key = `${s.path}|${s.scale}|${s.upY}`;
    if (!force && src?.key === key) return;
    dropCache();
    src = { key, parts: [], error: null };
    if (r.missing) { src.error = "missing"; return; }
    showMsg(L.loading);
    try {
      const res = await fetch(`/blob/model/${encodeURIComponent(r.srcKey)}?t=${encodeURIComponent(TOKEN)}`);
      if (!res.ok) throw new Error("fetch");
      const m = await loadModel(await res.arrayBuffer(), r.srcExt, { scale: s.scale, upY: s.upY });
      Object.assign(src, { ext: r.srcExt, file: r.srcName, parts: m.parts, offset: m.offset });
      msg.hidden = true;
    } catch (e) {
      console.warn("[model] load", e);
      src.error = "unreadable";
    }
  }
  function dropCache() { for (const m of cache.values()) try { m.delete(); } catch { /* 済み */ } cache.clear(); recipeKey = ""; }

  let building = 0;
  async function rebuild(fit = false) {
    if (!doc) return;
    if (src?.error) return showSourceError();
    const key = JSON.stringify([src?.key, doc.steps, doc.params]);
    if (key !== recipeKey) {
      const seq = ++building;
      if (doc.steps.length) showMsg(L.computing);
      const sources = new Map((src?.parts || []).map((p) => [p.id, p.geom]));
      let r;
      try { r = await runRecipe(doc, sources, cache); }
      catch (e) { r = { bodies: [...sources].map(([id, geom]) => ({ id, geom, from: "source" })), errors: [{ i: -1, msg: String(e.message || e) }] }; }
      if (seq !== building) return;
      bodies = r.bodies;
      errors = r.errors.map((x) => ({ ...x, msg: x.msg === "not-manifold" ? L.notClosed : x.msg }));
      recipeKey = key;
      msg.hidden = true;
      paintKey = "";
      showBodies();
      scheduleThumb();
    } else showBodies();
    viewer.setOverhang(overhang);
    clampSection();
    viewer.setSection(doc.section);
    viewer.setPins(doc.pins, activePin);
    if (fit) viewer.fit("iso");
    renderSide();
    updateDims();
  }
  // 塗り: 手順（doc.paint）が変わったときだけ、三角形ごとの色を計算し直す
  let paintKey = "";
  function applyPaint() {
    const key = JSON.stringify(doc.paint || []);
    if (key === paintKey) return;
    paintKey = key;
    for (const b of bodies) b.tri = paintColors(b.id, b.geom, doc.paint);
  }
  function showBodies() {
    applyPaint();
    viewer.setBodies(bodies.map((b) => ({ id: b.id, geom: b.geom, color: colorOf(b), hidden: !!doc.parts[b.id]?.hidden,
      triColors: b.tri, material: doc.parts[b.id]?.material || "plastic" })));
  }
  const colorOf = (b) => doc.parts[b.id]?.color || (doc.purpose === "game" ? src?.parts.find((p) => p.id === b.id)?.color : null) || null;
  function showMsg(text, button) {
    msg.hidden = false;
    msg.replaceChildren();
    const p = document.createElement("p");
    p.textContent = text;
    msg.append(p);
    if (button) msg.append(button);
  }
  function showSourceError() {
    viewer.setBodies([]);
    renderSide();
    updateDims();
    if (src.error === "missing") {
      const code = document.createElement("code");
      code.textContent = doc.source.path;
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = L.relink;
      b.addEventListener("click", async () => {
        const paths = await ctx.host.pickFiles(ctx.id).catch(() => null);
        if (!paths?.length) return;
        try { await ctx.call("relink", { name, path: paths[0] }); src = null; await open(name); }
        catch (e) { ctx.toast(e.message, "error"); }
      });
      showMsg(L.missing, code);
      msg.append(b);
    } else showMsg(L.unreadable);
  }

  // ---------- 保存・外での書き換え ----------
  let saving = false, saveTimer = null;
  function changed({ recompute = false } = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
    if (recompute) rebuild();
    else { viewer.setPins(doc.pins, activePin); renderSide(); updateDims(); }
  }
  async function save() {
    if (!name || !doc) return;
    clearTimeout(saveTimer); saveTimer = null; saving = true;
    try { mtime = (await ctx.call("save_model", { name, doc })).mtime; scheduleAI(false); }
    catch (e) { ctx.toast(e.message, "error"); }
    finally { saving = false; }
  }
  setInterval(async () => {
    if (saving || saveTimer || document.hidden || dragging) return;
    try {
      if (!name) {               // 「プログラムから開く」で新しく作られたら開く
        const s = await ctx.call("state");
        if (s.current && s.current !== st?.current && s.files.includes(s.current)) { st = s; await open(s.current); }
        return;
      }
      const r = await ctx.call("poll", { name });
      if (r.current && r.current !== name && r.current !== st?.current) { await refresh(); return open(r.current); }
      if (r.mtime && mtime && Math.abs(r.mtime - mtime) > 1e-6 && !saving && !saveTimer) await open(name, true);
    } catch { /* 次の回に */ }
  }, 1500);

  // ---------- 元に戻す ----------
  const snap = () => JSON.stringify(doc);
  function pushUndo() { undo.push(snap()); if (undo.length > 100) undo.shift(); redo.length = 0; }
  function doUndo() { if (!undo.length || !doc) return; redo.push(snap()); doc = JSON.parse(undo.pop()); changed({ recompute: true }); }
  function doRedo() { if (!redo.length || !doc) return; undo.push(snap()); doc = JSON.parse(redo.pop()); changed({ recompute: true }); }

  // ---------- 左の道具 ----------
  function buildRail() {
    const rail = el.querySelector(".mo-rail");
    rail.replaceChildren();
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.className = "mo-tool";
      b.innerHTML = `${IC[t]}<kbd>${t}</kbd>`;
      b.title = `${L.tools[t]}（${t}）`;
      b.setAttribute("aria-label", L.tools[t]);
      b.setAttribute("aria-pressed", String(t === "S" ? !!doc?.section.on : t === tool));
      b.addEventListener("click", () => setTool(t));
      rail.append(b);
    }
  }
  function setTool(t) {
    if (t === "S") {                 // 断面は切り替え（道具は変えない）
      pushUndo();
      doc.section.on = !doc.section.on;
      if (doc.section.on) clampSection(true);
      viewer.setSection(doc.section);
      changed();
      buildRail();
      ctx.setStatus(doc.section.on ? L.hints.S : L.hints[tool]);
      return;
    }
    const was = tool;
    tool = t;
    if (t !== "M") { measure = []; viewer.setMeasure([]); }
    stage.dataset.tool = t;
    buildRail();
    if ((was === "B") !== (t === "B") && doc) renderSide();
    ctx.setStatus(L.hints[t]);
  }

  // ---------- 上の切り替え・視点 ----------
  function buildTop() {
    const seg = el.querySelector(".mo-purpose");
    seg.replaceChildren();
    for (const p of ["print", "game"]) {
      const b = document.createElement("button");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(doc.purpose === p));
      b.innerHTML = `<span></span>`;
      b.firstChild.textContent = L.purpose[p];
      b.addEventListener("click", () => {
        if (doc.purpose === p) return;
        pushUndo();
        doc.purpose = p;
        store.set("purpose", p);
        viewer.setPurpose(p);
        buildTop();
        rebuild();
        changed();
      });
      seg.append(b);
    }
    const views = el.querySelector(".mo-views");
    views.replaceChildren();
    for (const [v, label] of [["iso", "3D"], ["front", EN ? "F" : "前"], ["right", EN ? "R" : "右"], ["top", EN ? "T" : "上"], ["fit", null]]) {
      const b = document.createElement("button");
      b.className = "mo-vbtn";
      b.title = L.views[v];
      if (label) b.textContent = label; else b.innerHTML = IC.fit;
      b.addEventListener("click", () => viewer.fit(v === "fit" ? lastView : (lastView = v), true));
      views.append(b);
    }
  }
  let lastView = "iso";

  // ---------- 寸法 ----------
  function updateDims() {
    const box = viewer.bounds();
    dims.replaceChildren();
    if (box.isEmpty()) return;
    const s = box.max.clone().sub(box.min);
    const tris = bodies.filter((b) => !doc.parts[b.id]?.hidden).reduce((n, b) => n + triCount(b.geom), 0);
    const size = document.createElement("span");
    size.className = "sz";
    if (doc.purpose === "game") size.textContent = `${fmt(s.x / 1000, 3)} × ${fmt(s.y / 1000, 3)} × ${fmt(s.z / 1000, 3)} m · ${L.tris(tris)}`;
    else size.textContent = `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm`;
    dims.append(size);
    if (doc.purpose === "print") {
      const ok = box.min.x >= -bed.w / 2 - 0.01 && box.max.x <= bed.w / 2 + 0.01 && box.min.y >= -bed.d / 2 - 0.01 && box.max.y <= bed.d / 2 + 0.01 && box.max.z <= bed.h + 0.01;
      const f = document.createElement("span");
      f.className = `fit ${ok ? "ok" : "ng"}`;
      f.textContent = ok ? L.fits : L.tooBig;
      dims.append(f);
    }
  }

  // ---------- 右の欄 ----------
  function section(title, cls) {
    const s = document.createElement("section");
    s.className = cls || "";
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    side.append(s);
    return s;
  }
  function sw(on, onChange, label) {
    const row = document.createElement("label");
    row.className = "mo-sw";
    const t = document.createElement("span");
    t.textContent = label;
    const b = document.createElement("button");
    b.className = "switch";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(on));
    b.innerHTML = `<span class="knob"></span>`;
    b.addEventListener("click", () => onChange(b.getAttribute("aria-checked") !== "true"));
    row.append(t, b);
    return row;
  }
  function numInput(value, { step = 0.1, min, max, onChange, unit }) {
    const wrap = document.createElement("span");
    wrap.className = "mo-num";
    const i = document.createElement("input");
    i.type = "number"; i.step = step; i.value = value;
    if (min !== undefined) i.min = min;
    if (max !== undefined) i.max = max;
    i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
    i.addEventListener("change", () => { const v = Number(i.value); if (Number.isFinite(v)) onChange(v); });
    wrap.append(i);
    if (unit) { const u = document.createElement("span"); u.textContent = unit; wrap.append(u); }
    return wrap;
  }

  function renderSide() {
    const scroll = side.scrollTop;
    side.replaceChildren();
    if (!doc) return;
    if (doc.note) {
      const s = section(L.note, "mo-note");
      const p = document.createElement("p");
      p.textContent = doc.note;
      s.append(p);
    }
    renderParts(); renderPaint(); renderSection(); renderPins(); renderParams(); renderRecipe(); renderSetup(); renderInfo();
    side.scrollTop = scroll;
  }

  function renderParts() {
    if (!bodies.length) return;
    const s = section(L.parts, "mo-parts");
    const ul = document.createElement("ul");
    for (const b of bodies) {
      const p = doc.parts[b.id] || {};
      const li = document.createElement("li");
      li.className = `mo-part${p.hidden ? " off" : ""}`;
      const eye = document.createElement("button");
      eye.className = "icon-btn";
      eye.innerHTML = p.hidden ? IC.eyeOff : IC.eye;
      eye.title = p.hidden ? L.show : L.hide;
      eye.addEventListener("click", () => setPart(b.id, { hidden: !p.hidden }));
      const chip = document.createElement("button");
      chip.className = "mo-chip";
      chip.title = L.color;
      chip.style.background = colorOf(b) || (doc.purpose === "game" ? "#C8CCD2" : "var(--model, #d4d8de)");
      chip.addEventListener("click", (e) => {
        const r = chip.getBoundingClientRect();
        const cur = doc.parts[b.id]?.material || "plastic";
        ctx.contextMenu([
          ...SWATCHES.map((c) => ({ label: c, icon: `<span class="mo-sw-dot" style="background:${c}"></span>`, onClick: () => setPart(b.id, { color: c }) })),
          "-",
          ...Object.keys(L.mats).map((k) => ({ label: `${L.material}: ${L.mats[k]}${k === cur ? " ✓" : ""}`, onClick: () => setPart(b.id, { material: k }) })),
        ], r.left, r.bottom + 4);
        e.stopPropagation();
      });
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = b.id;
      const ty = document.createElement("span");
      ty.className = "ty";
      ty.textContent = `${L.from[b.from] || ""}${p.material && p.material !== "plastic" ? ` · ${L.mats[p.material]}` : ""}${b.tri ? ` · ${L.painted}` : ""} · ${L.tris(triCount(b.geom))}`;
      li.append(eye, chip, nm, ty);
      ul.append(li);
    }
    s.append(ul);
  }
  function setPart(id, patch) {
    pushUndo();
    doc.parts[id] = { ...(doc.parts[id] || {}), ...patch };
    if ("hidden" in patch) viewer.setHidden(id, patch.hidden);
    else showBodies();
    viewer.setSection(doc.section);
    changed();
  }

  // 塗る
  const brushRadius = () => Math.max(0.05, (viewer.extent || 100) * brushPct / 100 / 2);
  function renderPaint() {
    if (tool !== "B" && doc.purpose !== "game") return;
    const s = section(L.paint, "mo-paint");
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "radiogroup");
    for (const m of ["face", "brush", "part"]) {
      const b = document.createElement("button");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(pmode === m));
      b.innerHTML = "<span></span>";
      b.firstChild.textContent = L.pmode[m];
      b.addEventListener("click", () => { pmode = m; store.set("pmode", m); if (tool !== "B") setTool("B"); renderSide(); });
      seg.append(b);
    }
    s.append(seg);
    const pal = document.createElement("div");
    pal.className = "mo-palette";
    const pick = (c) => { pcolor = c; store.set("pcolor", c); if (tool !== "B") setTool("B"); renderSide(); };
    for (const c of PALETTE) {
      const b = document.createElement("button");
      b.className = "mo-swatch";
      b.style.background = c;
      b.title = c;
      b.setAttribute("aria-pressed", String(pcolor === c));
      b.addEventListener("click", () => pick(c));
      pal.append(b);
    }
    const er = document.createElement("button");
    er.className = "mo-swatch eraser";
    er.innerHTML = IC.eraser;
    er.title = L.eraser;
    er.setAttribute("aria-pressed", String(pcolor === null));
    er.addEventListener("click", () => pick(null));
    const cust = document.createElement("label");
    cust.className = "mo-swatch custom";
    cust.title = L.custom;
    cust.setAttribute("aria-pressed", String(!!pcolor && !PALETTE.includes(pcolor)));
    if (pcolor && !PALETTE.includes(pcolor)) cust.style.background = pcolor;
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = pcolor || "#E5534B";
    inp.addEventListener("change", () => pick(inp.value.toUpperCase()));
    cust.append(inp);
    pal.append(er, cust);
    s.append(pal);
    if (pmode === "brush") {
      const row = document.createElement("div");
      row.className = "mo-row";
      const lab = document.createElement("span");
      lab.className = "mo-lab";
      lab.textContent = L.brushSize;
      const r = document.createElement("input");
      r.type = "range"; r.className = "mo-range"; r.min = 0.5; r.max = 20; r.step = 0.5; r.value = brushPct;
      const v = document.createElement("span");
      v.className = "mo-num";
      v.textContent = `${fmt(brushRadius() * 2, 1)} mm`;
      r.addEventListener("input", () => { brushPct = Number(r.value); store.set("brush", brushPct); v.textContent = `${fmt(brushRadius() * 2, 1)} mm`; });
      row.append(lab, r, v);
      s.append(row);
    }
    if (doc.paint?.length) {
      const clr = document.createElement("button");
      clr.className = "btn mo-clear";
      clr.textContent = L.clearPaint;
      clr.addEventListener("click", () => { pushUndo(); doc.paint = []; showBodies(); changed(); });
      s.append(clr);
    }
    if (doc.purpose === "game") {
      const n = document.createElement("p");
      n.className = "mo-none";
      n.textContent = L.paintHint;
      s.append(n);
    }
  }
  function addPaint(op) {
    pushUndo();
    (doc.paint ||= []).push(op);
    if (doc.paint.length > 2000) doc.paint.splice(0, doc.paint.length - 2000);
    showBodies();
    changed();
  }
  const r3 = (v) => v.map((x) => +x.toFixed(3));
  function paintClick(hit, e) {
    const b = bodies.find((x) => x.id === hit.part);
    if (!b) return;
    if (e.altKey) {                       // スポイト
      const c = (b.tri && b.tri[hit.tri]) || colorOf(b) || "#C8CCD2";
      pcolor = HEX.test(c) ? c.toUpperCase() : "#C8CCD2";
      store.set("pcolor", pcolor);
      return renderSide();
    }
    if (pmode === "part") {
      if (pcolor === null) {               // 部品の塗りを全部消す
        pushUndo();
        doc.paint = (doc.paint || []).filter((o) => o.of !== b.id);
        showBodies();
        return changed();
      }
      return addPaint({ of: b.id, color: pcolor });
    }
    if (pmode === "face") addPaint({ of: b.id, color: pcolor, where: { face: { p: r3(hit.p), n: r3(hit.n) } } });
  }
  let stroke = null;                      // 筆: { id, pts, radius }
  function strokeAdd(hit) {
    if (!stroke || hit.part !== stroke.id) return;
    const last = stroke.pts.at(-1);
    if (last && Math.hypot(hit.p[0] - last[0], hit.p[1] - last[1], hit.p[2] - last[2]) < stroke.radius / 3) return;
    stroke.pts.push(r3(hit.p));
    const b = bodies.find((x) => x.id === stroke.id);
    viewer.previewTris(stroke.id, select(b.geom, { points: [hit.p], radius: stroke.radius }), pcolor || colorOf(b));
  }

  // 断面
  function axisRange(axis) {
    const box = viewer.bounds(), k = { x: "x", y: "y", z: "z" }[axis];
    if (box.isEmpty()) return [0, 100];
    return [box.min[k], box.max[k]];
  }
  function clampSection(center = false) {
    const [lo, hi] = axisRange(doc.section.axis);
    if (center || doc.section.at < lo || doc.section.at > hi) doc.section.at = +(((lo + hi) / 2).toFixed(2));
  }
  function renderSection() {
    const s = section(L.section, "mo-section");
    s.append(sw(doc.section.on, (on) => { if (on !== doc.section.on) setTool("S"); }, L.cutOn));
    const body = document.createElement("div");
    body.className = "mo-secbody";
    body.hidden = !doc.section.on;
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "radiogroup");
    for (const a of ["x", "y", "z"]) {
      const b = document.createElement("button");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(doc.section.axis === a));
      b.innerHTML = `<span>${a.toUpperCase()}</span>`;
      b.addEventListener("click", () => { pushUndo(); doc.section.axis = a; clampSection(true); viewer.setSection(doc.section); changed(); });
      seg.append(b);
    }
    const flip = document.createElement("button");
    flip.className = "icon-btn";
    flip.innerHTML = IC.flip;
    flip.title = L.flip;
    flip.setAttribute("aria-pressed", String(doc.section.flip));
    flip.addEventListener("click", () => { pushUndo(); doc.section.flip = !doc.section.flip; viewer.setSection(doc.section); changed(); });
    const row = document.createElement("div");
    row.className = "mo-row";
    row.append(seg, flip);
    const [lo, hi] = axisRange(doc.section.axis);
    const range = document.createElement("input");
    range.type = "range"; range.className = "mo-range";
    range.min = lo; range.max = hi; range.step = Math.max(0.01, (hi - lo) / 500); range.value = doc.section.at;
    let pushed = false;
    range.addEventListener("input", () => {
      if (!pushed) { pushUndo(); pushed = true; }
      doc.section.at = +Number(range.value).toFixed(2);
      viewer.setSection(doc.section);
      num.querySelector("input").value = doc.section.at;
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 400);
    });
    range.addEventListener("change", () => { pushed = false; });
    const num = numInput(doc.section.at, { step: 0.1, unit: "mm", onChange: (v) => { pushUndo(); doc.section.at = v; viewer.setSection(doc.section); changed(); } });
    const row2 = document.createElement("div");
    row2.className = "mo-row";
    row2.append(range, num);
    body.append(row, row2);
    s.append(body);
  }

  // ピン
  function renderPins() {
    const s = section(L.pins, "mo-pinlist");
    if (!doc.pins.length) {
      const p = document.createElement("p");
      p.className = "mo-none";
      p.textContent = L.noPins;
      s.append(p);
      return;
    }
    for (const pin of doc.pins) {
      const box = document.createElement("div");
      box.className = `mo-pinrow${pin.id === activePin ? " on" : ""}`;
      box.dataset.id = pin.id;
      const badge = document.createElement("button");
      badge.className = "mo-badge";
      badge.textContent = pin.id;
      badge.title = pin.part;
      badge.addEventListener("click", () => selectPin(pin.id, true));
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = L.pinPh;
      ta.value = pin.text;
      let pushed = false;
      ta.addEventListener("focus", () => { activePin = pin.id; viewer.setPins(doc.pins, activePin); box.classList.add("on"); });
      ta.addEventListener("input", () => { if (!pushed) { pushUndo(); pushed = true; } pin.text = ta.value.slice(0, 500); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); viewer.setPins(doc.pins, activePin); });
      ta.addEventListener("blur", () => { pushed = false; });
      ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") ta.blur(); });
      const del = document.createElement("button");
      del.className = "icon-btn";
      del.innerHTML = IC.trash;
      del.title = L.delPin;
      del.addEventListener("click", () => deletePin(pin.id));
      box.append(badge, ta, del);
      s.append(box);
    }
  }
  function selectPin(id, focus = false) {
    activePin = id;
    viewer.setPins(doc.pins, activePin);
    for (const r of side.querySelectorAll(".mo-pinrow")) r.classList.toggle("on", Number(r.dataset.id) === id);
    const row = side.querySelector(`.mo-pinrow[data-id="${id}"]`);
    row?.scrollIntoView({ block: "nearest" });
    if (focus) row?.querySelector("textarea")?.focus();
  }
  function addPin(hit) {
    pushUndo();
    const used = new Set(doc.pins.map((p) => p.id));
    let id = 1;
    while (used.has(id)) id++;
    if (id > 99) return;
    const r = (v) => v.map((x) => +x.toFixed(3));
    doc.pins.push({ id, p: r(hit.p), n: r(hit.n), part: hit.part, text: "" });
    activePin = id;
    changed();
    requestAnimationFrame(() => selectPin(id, true));
  }
  function deletePin(id) {
    pushUndo();
    doc.pins = doc.pins.filter((p) => p.id !== id);
    if (activePin === id) activePin = null;
    changed();
  }

  // 数値（Claude が params に書いた物をスライダーで）
  function renderParams() {
    const keys = Object.keys(doc.params || {});
    if (!keys.length) return;
    const s = section(L.params, "mo-params");
    for (const k of keys) {
      const p = doc.params[k];
      const row = document.createElement("div");
      row.className = "mo-param";
      const lab = document.createElement("span");
      lab.className = "lb";
      lab.textContent = p.label || k;
      lab.title = `$${k}`;
      const range = document.createElement("input");
      range.type = "range"; range.className = "mo-range";
      range.min = p.min; range.max = p.max; range.step = p.step; range.value = p.value;
      const num = numInput(p.value, { step: p.step, min: p.min, max: p.max, onChange: (v) => set(v, true) });
      let pushed = false, timer = null;
      const set = (v, now) => {
        if (!pushed) { pushUndo(); pushed = true; }
        p.value = Math.min(p.max, Math.max(p.min, v));
        num.querySelector("input").value = p.value;
        range.value = p.value;
        clearTimeout(timer);
        timer = setTimeout(() => { pushed = false; changed({ recompute: true }); }, now ? 0 : 120);
      };
      range.addEventListener("input", () => set(Number(range.value)));
      range.addEventListener("dblclick", () => set(p.min <= 0 && p.max >= 0 ? 0 : p.min, true));
      row.append(lab, range, num);
      s.append(row);
    }
  }

  function renderRecipe() {
    const s = section(L.recipe, "mo-recipe");
    const p = document.createElement("p");
    p.className = doc.steps.length ? "mo-steps" : "mo-none";
    p.textContent = doc.steps.length ? L.steps(doc.steps.length) : L.noSteps;
    s.append(p);
    for (const e of errors) {
      const x = document.createElement("p");
      x.className = "mo-err";
      x.textContent = L.stepErr(e.i, e.msg);
      s.append(x);
    }
  }

  function renderSetup() {
    const s = section(L.setup[doc.purpose], "mo-setup");
    if (doc.purpose === "print") {
      const lab = document.createElement("div");
      lab.className = "mo-lab";
      lab.textContent = L.bed;
      const sel = selectBox({
        options: BEDS.map(([v, label, w, d, h]) => ({ value: v, label: label ? `${label}（${w}×${d}×${h}）` : L.custom })),
        value: bed.preset,
        onChange: (v) => {
          const b = BEDS.find((x) => x[0] === v);
          bed = v === "custom" ? { ...bed, preset: v } : { preset: v, w: b[2], d: b[3], h: b[4] };
          store.set("bed", bed); viewer.setBed(bed); renderSide(); updateDims();
        },
      });
      s.append(lab, sel);
      if (bed.preset === "custom") {
        const row = document.createElement("div");
        row.className = "mo-row mo-bed";
        for (const k of ["w", "d", "h"]) row.append(numInput(bed[k], { step: 1, min: 10, max: 2000, unit: k === "h" ? "mm" : "×", onChange: (v) => { bed[k] = v; store.set("bed", bed); viewer.setBed(bed); updateDims(); } }));
        s.append(row);
      }
      s.append(sw(overhang, (on) => { overhang = on; store.set("overhang", on); viewer.setOverhang(on); renderSide(); }, L.overhang));
    }
    if (doc.source && src?.parts?.length) {          // 大きさ（元のファイルの倍率）
      const row = document.createElement("div");
      row.className = "mo-row mo-scale";
      const box = viewer.bounds(), hz = box.isEmpty() ? 0 : box.max.z - box.min.z;
      const l1 = document.createElement("span"); l1.textContent = L.scale;
      const l2 = document.createElement("span"); l2.textContent = L.height;
      row.append(l1, numInput(+doc.source.scale.toPrecision(6), { step: 0.1, min: 0.0001, onChange: (v) => setScale(v) }),
        l2, numInput(+hz.toFixed(2), { step: 1, min: 0.01, unit: "mm", onChange: (v) => { if (hz > 0) setScale(doc.source.scale * v / hz); } }));
      s.append(row);
      if (doc.source.upY && doc.source.scale === 1000) {
        const n = document.createElement("p"); n.className = "mo-none"; n.textContent = L.glbUnit; s.append(n);
      }
    }
    if (!s.querySelector("*:not(h3)")) s.remove();
  }
  async function setScale(v) {
    if (!(v > 0)) return;
    pushUndo();
    doc.source.scale = +v.toPrecision(6);
    const r = await ctx.call("open_model", { name }).catch(() => null);
    await save();
    if (r) { await loadSource({ ...r, missing: false }, true); await rebuild(true); }
  }

  function renderInfo() {
    const s = section(L.info, "mo-info");
    const dl = document.createElement("dl");
    const add = (k, v) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dd.title = v; dl.append(dt, dd); };
    if (src?.file) add(L.file, src.file);
    const box = viewer.bounds();
    if (!box.isEmpty()) {
      const z = box.max.clone().sub(box.min);
      add(L.size, doc.purpose === "game" ? `${fmt(z.x / 1000, 3)} × ${fmt(z.y / 1000, 3)} × ${fmt(z.z / 1000, 3)} m` : `${fmt(z.x)} × ${fmt(z.y)} × ${fmt(z.z)} mm`);
    }
    const vis = bodies.filter((b) => !doc.parts[b.id]?.hidden);
    if (vis.length) {
      add(L.triangles, vis.reduce((n, b) => n + triCount(b.geom), 0).toLocaleString());
      if (doc.purpose === "print") add(L.volume, `${fmt(vis.reduce((v, b) => v + volumeOf(b.geom), 0) / 1000, 2)} cm³`);
      else add(L.origin, L.originV);
    }
    s.append(dl);
  }

  // ---------- 形の上での操作 ----------
  const gl = el.querySelector(".mo-gl");
  let down = null, dragging = false;
  gl.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, b: e.button }; dragging = true;
    if (tool === "B" && pmode === "brush" && e.button === 0 && !e.altKey && doc) {   // 筆: 形の上から始めたら回さずに塗る
      const hit = viewer.pick(e.clientX, e.clientY);
      if (hit) {
        viewer.controls.enabled = false;
        stroke = { id: hit.part, pts: [], radius: brushRadius() };
        strokeAdd(hit);
      }
    }
  }, { capture: true });
  gl.addEventListener("pointermove", (e) => {
    if (!stroke) return;
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) strokeAdd(hit);
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    viewer.controls.enabled = true;
    if (s.pts.length) addPaint({ of: s.id, color: pcolor, where: { points: s.pts, radius: +s.radius.toFixed(3) } });
  });
  gl.addEventListener("pointerup", (e) => {
    if (!down || down.b !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
    down = null;
    const hit = viewer.pick(e.clientX, e.clientY);
    if (tool === "P" && hit) addPin(hit);
    else if (tool === "B" && hit && (pmode !== "brush" || e.altKey)) paintClick(hit, e);
    else if (tool === "M") {
      if (!hit) return;
      if (measure.length >= 2) measure = [];
      measure.push(hit.p);
      viewer.setMeasure(measure);
      if (measure.length === 2) {
        const [a, b] = measure, d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        ctx.setStatus(`${L.measure(fmt(d, 2))}（ΔX ${fmt(Math.abs(a[0] - b[0]), 2)} ・ ΔY ${fmt(Math.abs(a[1] - b[1]), 2)} ・ ΔZ ${fmt(Math.abs(a[2] - b[2]), 2)}）`);
      }
    }
  });
  gl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!doc) return;
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return;
    ctx.contextMenu([
      { label: L.pinHere, icon: IC.P, onClick: () => addPin(hit) },
      { label: L.cutHere, icon: IC.S, onClick: () => { pushUndo(); Object.assign(doc.section, { on: true, at: +hit.p[{ x: 0, y: 1, z: 2 }[doc.section.axis]].toFixed(2) }); viewer.setSection(doc.section); buildRail(); changed(); } },
      { label: L.hidePart, icon: IC.eyeOff, onClick: () => setPart(hit.part, { hidden: true }) },
    ], e.clientX, e.clientY);
  });
  el.querySelector(".mo-gl").addEventListener("click", (e) => {
    const pin = e.target.closest(".mo-pin");
    if (pin) selectPin(Number(pin.dataset.id), true);
  });
  gl.addEventListener("wheel", (e) => {          // Shift + ホイール = 断面を動かす
    if (!e.shiftKey || !doc?.section.on) return;
    e.preventDefault(); e.stopPropagation();
    const [lo, hi] = axisRange(doc.section.axis), step = (hi - lo) / 100 || 1;
    doc.section.at = +Math.min(hi, Math.max(lo, doc.section.at - Math.sign(e.deltaY || e.deltaX) * step)).toFixed(2);
    viewer.setSection(doc.section);
    const r = side.querySelector(".mo-section .mo-range"), n = side.querySelector(".mo-section .mo-num input");
    if (r) r.value = doc.section.at;
    if (n) n.value = doc.section.at;
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 400);
  }, { capture: true, passive: false });

  window.addEventListener("keydown", (e) => {
    if (!doc || edit.hidden || e.target.closest?.("input, textarea, [contenteditable]")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return e.shiftKey ? doRedo() : doUndo(); }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); return doRedo(); }
    if ((e.ctrlKey || e.metaKey) && k === "e") { e.preventDefault(); return openExport(); }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (TOOLS.includes(e.key.toUpperCase())) return setTool(e.key.toUpperCase());
    const view = { 0: "iso", 1: "front", 3: "right", 7: "top" }[e.key];
    if (view) { lastView = view; return viewer.fit(view, true); }
    if (k === "f") return viewer.fit(lastView, true);
    if (e.key === "Escape") { measure = []; viewer.setMeasure([]); ctx.setStatus(L.hints[tool]); }
    if ((e.key === "Delete" || e.key === "Backspace") && activePin) deletePin(activePin);
  });

  // ---------- AI に渡す ----------
  let aiTimer = null;
  function scheduleAI(image) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => writeAI(image).catch((e) => console.warn("[model] ai", e)), image ? 1200 : 1500);
  }
  const upload = (blob, args) => ctx.upload("save_out", blob, args);
  async function aiData() {
    const r3 = (v) => v.toArray().map((x) => +x.toFixed(2));
    const parts = [];
    for (const b of bodies) {
      b.geom.computeBoundingBox();
      const bb = b.geom.boundingBox;
      parts.push({ id: b.id, from: b.from, hidden: !!doc.parts[b.id]?.hidden, min: r3(bb.min), max: r3(bb.max), size: r3(bb.max.clone().sub(bb.min)),
        triangles: triCount(b.geom), volume_cm3: +(volumeOf(b.geom) / 1000).toFixed(3),
        color: colorOf(b) || null, material: doc.parts[b.id]?.material || "plastic", painted_colors: b.tri ? [...new Set(b.tri.filter(Boolean))] : [] });
    }
    const sections = [];
    const wanted = [...(doc.section.on ? [{ axis: doc.section.axis, at: doc.section.at, of: "", current: true }] : []), ...(doc.measure || [])];
    for (const m of wanted) {
      for (const b of bodies) {
        if (m.of && m.of !== b.id) continue;
        if (!m.of && doc.parts[b.id]?.hidden) continue;
        const poly = await sectionPolygons(b.geom, m.axis, m.at).catch(() => null);
        sections.push({ axis: m.axis, at: m.at, part: b.id, coords: { z: "[x, y]", x: "[y, z]", y: "[x, z]" }[m.axis], ...(m.current ? { current: true } : {}),
          ...(poly ? poly : { error: "not closed" }) });
      }
    }
    return {
      format: "hub-model-ai/1", name, purpose: doc.purpose, units: "mm", axes: "Z up, X right, Y back (front view looks toward +Y)",
      origin: "bottom center of the original file", source: src?.file ? { file: src.file, scale: doc.source.scale, upY: doc.source.upY } : null,
      bed: doc.purpose === "print" ? { w: bed.w, d: bed.d, h: bed.h, centered: true } : undefined,
      parts, pins: doc.pins, sections, errors: errors.map((e) => L.stepErr(e.i, e.msg)),
      image: `_ai/${name}.png (2×2: angled, front, right, top; yellow numbers = pins)`,
    };
  }
  async function writeAI(image) {
    if (!name || !doc) return;
    const at = name;
    const data = await aiData();
    if (at !== name) return;
    await upload(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), { name, kind: "ai", format: "json" });
    if (!image) return;
    const W = 640, H = 480, out = document.createElement("canvas");
    out.width = W * 2; out.height = H * 2;
    const g = out.getContext("2d");
    g.fillStyle = "#f4f5f7"; g.fillRect(0, 0, out.width, out.height);
    const labels = EN ? ["Angled", "Front (looking +Y)", "Right (looking −X)", "Top (looking −Z)"] : ["斜め", "前（+Y を見る）", "右（−X を見る）", "上（−Z を見る）"];
    ["iso", "front", "right", "top"].forEach((v, i) => {
      const c = viewer.shot(v, W, H, { bg: "#f4f5f7" });
      const x = (i % 2) * W, y = Math.floor(i / 2) * H;
      g.drawImage(c, x, y);
      g.fillStyle = "#333"; g.font = '600 18px "Segoe UI", "Yu Gothic UI", sans-serif'; g.textBaseline = "top";
      g.fillText(labels[i], x + 12, y + 10);
    });
    g.strokeStyle = "#c9ccd1"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(W, 0); g.lineTo(W, H * 2); g.moveTo(0, H); g.lineTo(W * 2, H); g.stroke();
    const blob = await new Promise((ok) => out.toBlob(ok, "image/png"));
    if (at === name) await upload(blob, { name, kind: "ai", format: "png" });
  }
  async function sendAI() {
    if (!doc) return;
    try {
      await save();
      await writeAI(true);
      const pins = doc.pins.length ? doc.pins.map((p) => `${p.id}. ${p.text || L.noPinText}`).join("\n") : "-";
      await navigator.clipboard.writeText(L.prompt(name, pins)).catch(() => {});
      ctx.toast(L.sent, "info", 6000);
    } catch (e) { ctx.toast(e.message, "error"); }
  }

  // ---------- 一覧の小さな画像 ----------
  let thumbTimer = null;
  function scheduleThumb() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(async () => {
      if (!name || !bodies.length) return;
      const c = viewer.shot("iso", 320, 240, { pins: false });
      const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
      upload(blob, { name, kind: "thumb", format: "png" }).catch(() => {});
    }, 2500);
  }

  // ---------- 書き出し ----------
  function openExport(e) {
    if (!doc) return;
    const order = doc.purpose === "game" ? ["glb", "stl", "3mf"] : ["stl", "stlEach", "3mf", "glb"];
    const r = e?.currentTarget?.getBoundingClientRect?.() || exportBtn.getBoundingClientRect();
    ctx.contextMenu(order.map((f) => ({ label: L.ex[f], icon: IC.export, onClick: () => doExport(f) })), r.left, r.bottom + 4);
  }
  async function doExport(kind) {
    applyPaint();
    const vis = bodies.filter((b) => !doc.parts[b.id]?.hidden).map((b) => ({ ...b, color: colorOf(b), material: doc.parts[b.id]?.material || "plastic" }));
    if (!vis.length) return ctx.toast(L.nothing, "error");
    ctx.setStatus(L.exporting);
    try {
      const files = [];
      if (kind === "stl") files.push([toSTL(vis), "stl", ""]);
      else if (kind === "stlEach") for (const b of vis) files.push([toSTL([b]), "stl", vis.length > 1 ? `-${b.id}` : ""]);
      else if (kind === "3mf") files.push([to3MF(vis), "3mf", ""]);
      else files.push([await toGLB(vis), "glb", ""]);
      let last = null;
      for (const [bytes, format, suffix] of files) last = await upload(new Blob([bytes]), { name, kind: "export", format, suffix });
      ctx.toast(L.exported(files.length > 1 ? `${files.length} files` : last.file), "info", 5000);
      ctx.call("reveal", { kind: "export", file: last.file }).catch(() => {});
    } catch (err) { ctx.toast(err.message, "error"); }
    finally { ctx.setStatus(L.hints[tool]); }
  }

  // ---------- はじめ ----------
  manifold().catch((e) => console.warn("[model] manifold", e));     // 先に読み込んでおく（最初の計算を速く）
  await refresh();
  stage.dataset.tool = tool;
  if (st.current && st.files.includes(st.current)) await open(st.current);
  else showHome();
  ctx.setStatus(name ? L.hints[tool] : "");
}
