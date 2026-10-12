"""model/api.py — モデルスケッチ。3D を見て・切って・ピンで指し、Claude にレシピで形を足してもらう。

・データは、フォルダ窓の置き場所の下の「Model Sketch」フォルダにある <名前>.model.json（Claude と共有する）
・元の 3D ファイル（STL / 3MF / OBJ / GLB）は動かさず、JSON に場所を書いておく。画面へは /blob/model/src-<名前> で渡す
・表示・断面・レシピの計算（manifold）・書き出しの作成は画面（three.js）。ここは開く・保存・ファイルの受け渡しだけ
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path

_ctx = None

EXT = ".model.json"
FORMAT = "hub-model/1"
FOLDER_NAME = "Model Sketch"
GUIDE = "MODEL_FORMAT.md"
AI_DIR = "_ai"
EXPORT_DIR = "export"
MODEL_EXTS = {".stl", ".3mf", ".obj", ".glb", ".gltf"}
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
OUT_MAX = 200 * 1024 * 1024
NAME_RE = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]{1,80}$")
ID_RE = re.compile(r"^[A-Za-z_][\w\-]{0,39}$")
STEP_MAX = 400
PIN_MAX = 99
PAINT_MAX = 2000
MATERIALS = ("plastic", "matte", "gloss", "metal")
HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}")


class ModelError(Exception):
    pass


def setup(ctx):
    global _ctx
    _ctx = ctx


# ---------- 保存先 ----------
def _folder() -> Path:
    """既定は フォルダ窓の置き場所\\Model Sketch（無ければ作る）。設定 modules.model.folder で変えられる。"""
    p = (_ctx.config or {}).get("folder")
    if not p:
        root = ((getattr(_ctx.host, "config", None) or {}).get("modules") or {}).get("folders", {}).get("root") or "~/Hub"
        p = Path(root).expanduser() / FOLDER_NAME
    f = Path(p).expanduser()
    f.mkdir(parents=True, exist_ok=True)
    guide, ours = f / GUIDE, Path(__file__).with_name(GUIDE)
    try:  # Claude が読む説明書。同梱の版と違えば置き直す
        if ours.is_file() and (not guide.is_file() or guide.read_bytes() != ours.read_bytes()):
            _write_atomic(guide, ours.read_text(encoding="utf-8"))
    except OSError:
        pass
    return f


def _thumbs() -> Path:
    d = Path(_ctx.data_dir) / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name) or name.strip() != name or name in (".", ".."):
        raise ModelError(f"名前に使えない文字があります: {name}")
    return name


def _path(name: str) -> Path:
    return _folder() / f"{_check_name(name)}{EXT}"


def _write_atomic(path: Path, data: str | bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".model-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data.encode("utf-8") if isinstance(data, str) else data)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def _free_name(stem: str) -> str:
    stem = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", stem).strip()[:70] or "model"
    folder = _folder()
    if not (folder / f"{stem}{EXT}").exists():
        return stem
    for i in range(2, 1000):
        if not (folder / f"{stem} ({i}){EXT}").exists():
            return f"{stem} ({i})"
    raise ModelError("同じ名前のファイルが多すぎます")


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        p = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not p.exists():
            return p
    raise ModelError("同じ名前のファイルが多すぎます")


# ---------- 形をそろえる ----------
def _num(v, lo, hi, default):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if f != f else max(lo, min(hi, f))


def _vec(v, n=3, lim=1e6):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        return None
    return [round(_num(x, -lim, lim, 0.0), 4) for x in v]


def new_doc(src: Path | None) -> dict:
    is_glb = bool(src) and src.suffix.lower() in (".glb", ".gltf")
    return {
        "format": FORMAT,
        "purpose": "print",
        "source": {"path": str(src), "scale": 1000.0 if is_glb else 1.0, "upY": is_glb} if src else None,
        "params": {},
        "steps": [],
        "parts": {},
        "pins": [],
        "section": {"on": False, "axis": "z", "at": 0.0, "flip": False},
        "measure": [],
        "paint": [],
    }


def _clean_step(s, i: int, warn: list[str]) -> dict | None:
    if not isinstance(s, dict) or not isinstance(s.get("op"), str):
        warn.append(f"steps[{i}] を読み飛ばした（op が無い）")
        return None
    try:
        text = json.dumps(s, ensure_ascii=False)
    except (TypeError, ValueError):
        warn.append(f"steps[{i}] を読み飛ばした（JSON にできない値）")
        return None
    if len(text) > 200_000:
        warn.append(f"steps[{i}] を読み飛ばした（大きすぎる）")
        return None
    return s      # 中身の検査は計算する画面側（recipe.js）で行い、だめな手順はその場で知らせる


def normalize(raw) -> tuple[dict, list[str]]:
    """読み込んだ JSON を画面で扱える形に直す。読めない所は捨てて warnings に残す。"""
    if not isinstance(raw, dict):
        raise ModelError("中身が JSON のオブジェクトではありません")
    warn: list[str] = []
    src = raw.get("source") if isinstance(raw.get("source"), dict) else None
    out = new_doc(None)
    if src and src.get("path"):
        out["source"] = {"path": str(src["path"]), "scale": _num(src.get("scale"), 1e-4, 1e5, 1.0), "upY": bool(src.get("upY", False))}
    out["purpose"] = raw.get("purpose") if raw.get("purpose") in ("print", "game") else "print"
    params = {}
    for k, p in (raw.get("params") or {}).items() if isinstance(raw.get("params"), dict) else ():
        if not ID_RE.match(str(k)):
            warn.append(f"params.{k} を読み飛ばした（名前は英数字と _ -）")
            continue
        p = p if isinstance(p, dict) else {"value": p}
        lo, hi = _num(p.get("min"), -1e6, 1e6, 0.0), _num(p.get("max"), -1e6, 1e6, 100.0)
        if hi <= lo:
            lo, hi = min(lo, hi), max(lo, hi) + 1
        params[str(k)] = {"value": _num(p.get("value"), lo, hi, lo), "min": lo, "max": hi,
                          "step": _num(p.get("step"), 1e-4, 1e5, 0.1), "label": str(p.get("label") or k)[:40]}
    out["params"] = params
    steps = raw.get("steps") if isinstance(raw.get("steps"), list) else []
    if len(steps) > STEP_MAX:
        warn.append(f"steps は {STEP_MAX} 個まで。後ろを読み飛ばした")
    out["steps"] = [c for i, s in enumerate(steps[:STEP_MAX]) if (c := _clean_step(s, i, warn)) is not None]
    parts = {}
    for k, p in (raw.get("parts") or {}).items() if isinstance(raw.get("parts"), dict) else ():
        if ID_RE.match(str(k)) and isinstance(p, dict):
            c = p.get("color")
            m = p.get("material")
            parts[str(k)] = {"hidden": bool(p.get("hidden", False)),
                             **({"color": c} if isinstance(c, str) and HEX_RE.fullmatch(c) else {}),
                             **({"material": m} if m in MATERIALS else {})}
    out["parts"] = parts
    pins, seen = [], set()
    for i, p in enumerate(raw.get("pins") or []):
        pos = _vec(p.get("p")) if isinstance(p, dict) else None
        if pos is None:
            warn.append(f"pins[{i}] を読み飛ばした（p は [x, y, z]）")
            continue
        pid = int(_num(p.get("id"), 1, PIN_MAX, len(pins) + 1))
        while pid in seen:
            pid += 1
        seen.add(pid)
        pins.append({"id": pid, "p": pos, "n": _vec(p.get("n")) or [0, 0, 1], "part": str(p.get("part") or "")[:40],
                     "text": str(p.get("text") or "")[:500]})
    out["pins"] = pins[:PIN_MAX]
    sec = raw.get("section") if isinstance(raw.get("section"), dict) else {}
    out["section"] = {"on": bool(sec.get("on", False)), "axis": sec.get("axis") if sec.get("axis") in ("x", "y", "z") else "z",
                      "at": round(_num(sec.get("at"), -1e6, 1e6, 0.0), 3), "flip": bool(sec.get("flip", False))}
    meas = []
    for m in (raw.get("measure") or [])[:20] if isinstance(raw.get("measure"), list) else ():
        if isinstance(m, dict) and m.get("axis") in ("x", "y", "z"):
            meas.append({"axis": m["axis"], "at": round(_num(m.get("at"), -1e6, 1e6, 0.0), 3), "of": str(m.get("of") or "")[:40]})
    out["measure"] = meas
    paint = []
    for i, o in enumerate(raw.get("paint") or [] if isinstance(raw.get("paint"), list) else []):
        c = o.get("color") if isinstance(o, dict) else "?"
        if not isinstance(o, dict) or not (c is None or (isinstance(c, str) and HEX_RE.fullmatch(c))):
            warn.append(f"paint[{i}] を読み飛ばした（color は #RRGGBB か null）")
            continue
        op = {"color": c}
        of = o.get("of")
        if isinstance(of, str) and ID_RE.match(of):
            op["of"] = of
        elif isinstance(of, list):
            op["of"] = [str(x) for x in of if isinstance(x, str) and ID_RE.match(x)][:50]
        w = o.get("where")
        if isinstance(w, dict) and w:
            if isinstance(w.get("points"), list) and len(w["points"]) > 2000:
                w = {**w, "points": w["points"][:2000]}
            try:
                if len(json.dumps(w)) > 100_000:
                    raise ValueError
            except (TypeError, ValueError):
                warn.append(f"paint[{i}] を読み飛ばした（where が大きすぎる・読めない）")
                continue
            op["where"] = w
        paint.append(op)
    if len(paint) > PAINT_MAX:
        warn.append(f"paint は {PAINT_MAX} 個まで。古い方を捨てた")
        paint = paint[-PAINT_MAX:]
    out["paint"] = paint
    for k in ("note",):       # Claude が残すひとこと（画面に出す）
        if isinstance(raw.get(k), str):
            out[k] = raw[k][:2000]
    return out, warn


def _dump(doc: dict) -> str:
    """読みやすさのため、短い数の配列は 1 行にまとめる。"""
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    return re.sub(r"\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)(?:,\s+(-?[\d.e+-]+))?\s+\]",
                  lambda m: "[" + ", ".join(g for g in m.groups() if g is not None) + "]", text) + "\n"


# ---------- 画面から呼ぶ ----------
def state() -> dict:
    f = _folder()
    files = sorted(f.glob(f"*{EXT}"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {"folder": str(f), "files": [p.name[: -len(EXT)] for p in files],
            "current": _ctx.store.get("model", "current", None)}


def add_files(paths: list[str]) -> dict:
    """3D ファイル（またはモデルスケッチ）を落とされたとき。ファイルごとに .model.json を作る。"""
    made, skipped = [], []
    for raw in paths or []:
        p = Path(str(raw))
        if p.is_file() and p.name.endswith(EXT):
            if p.parent.resolve() != _folder().resolve():
                skipped.append(f"{p.name}（「{FOLDER_NAME}」フォルダの中のものだけ開けます）")
                continue
            made.append(p.name[: -len(EXT)])
            continue
        if not p.is_file() or p.suffix.lower() not in MODEL_EXTS:
            skipped.append(p.name)
            continue
        name = _free_name(p.stem)
        _write_atomic(_path(name), _dump(new_doc(p.resolve())))
        made.append(name)
    if made:
        _ctx.store.set("model", "current", made[-1])
    return {"made": made, "skipped": skipped}


def new_model(purpose: str = "print", name: str = "") -> dict:
    """元のファイル無しで始める（Claude にレシピで作ってもらう）。name は画面の言葉での既定の名前。"""
    name = _free_name(str(name or "新しいモデル"))
    doc = new_doc(None)
    doc["purpose"] = "game" if purpose == "game" else "print"
    _write_atomic(_path(name), _dump(doc))
    _ctx.store.set("model", "current", name)
    return {"name": name}


def open_path(path: str) -> str:
    """「プログラムから開く」。パネル id を返す。"""
    r = add_files([path])
    if not r["made"]:
        raise ModelError(f"開けないファイルです: {Path(str(path)).name}")
    return "model"


def _read(name: str) -> tuple[Path, dict, list[str]]:
    p = _path(name)
    if not p.exists():
        raise ModelError(f"見つかりません: {name}")
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ModelError(f"{p.name} の JSON が壊れています（{e.lineno} 行目: {e.msg}）")
    doc, warn = normalize(raw)
    return p, doc, warn


def open_model(name: str) -> dict:
    p, doc, warn = _read(name)
    _ctx.store.set("model", "current", name)
    src = doc["source"]
    missing = bool(src) and not Path(src["path"]).is_file()
    return {"name": name, "doc": doc, "warnings": warn, "mtime": p.stat().st_mtime, "missing": missing,
            "srcKey": f"src-{name}" if src else None, "srcExt": Path(src["path"]).suffix.lower() if src else None,
            "srcName": Path(src["path"]).name if src else None}


def save_model(name: str, doc: dict) -> dict:
    clean, warn = normalize(doc)
    p = _path(name)
    _write_atomic(p, _dump(clean))
    return {"mtime": p.stat().st_mtime, "warnings": warn}


def poll(name: str) -> dict:
    p = _path(name)
    return {"mtime": p.stat().st_mtime if p.exists() else None, "current": _ctx.store.get("model", "current", None)}


def relink(name: str, path: str) -> dict:
    data = open_model(name)
    p = Path(str(path))
    if not p.is_file() or p.suffix.lower() not in MODEL_EXTS:
        raise ModelError(f"3D のファイルを指定してください: {p.name}")
    data["doc"]["source"] = new_doc(p.resolve())["source"]
    save_model(name, data["doc"])
    return open_model(name)


def reveal(name: str | None = None, kind: str = "", file: str = "") -> bool:
    target = _folder()
    if name and kind == "ai":
        p = _folder() / AI_DIR / f"{_check_name(name)}.png"
        target = p if p.is_file() else target
    elif kind == "export" and file:
        p = _folder() / EXPORT_DIR / Path(str(file)).name
        target = p if p.is_file() else target
    if _ctx.host is not None and hasattr(_ctx.host, "reveal_path"):
        _ctx.host.reveal_path(str(target))
    return True


def _check_out(data: bytes, fmt: str) -> None:
    ok = {
        "png": data.startswith(PNG_MAGIC),
        "glb": data[:4] == b"glTF",
        "stl": len(data) >= 84 and len(data) == 84 + 50 * int.from_bytes(data[80:84], "little"),
        "json": True,
    }.get(fmt, False)
    if fmt == "3mf":
        try:
            with zipfile.ZipFile(BytesIO(data)) as z:
                ok = "3D/3dmodel.model" in z.namelist()
        except zipfile.BadZipFile:
            ok = False
    if fmt == "json":
        try:
            json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            ok = False
    if not ok or len(data) > OUT_MAX:
        raise ModelError(f"{fmt} のデータが正しくありません")


def save_out(data: bytes, name: str = "", kind: str = "export", format: str = "stl", suffix: str = "") -> dict:
    """画面が作ったファイルを受け取って保存する（Hub 0.8 の upload）。
    kind="ai": _ai/<名前>.png / .json（毎回置き換える） / "thumb": 一覧の小さな画像 / "export": export/<名前><suffix>.<stl|3mf|glb>（上書きしない）"""
    _check_name(name)
    if not _path(name).exists():
        raise ModelError(f"見つかりません: {name}")
    fmt = str(format)
    if kind == "ai" and fmt in ("png", "json"):
        out_dir = _folder() / AI_DIR
        out = out_dir / f"{name}.{fmt}"
    elif kind == "thumb" and fmt == "png":
        out_dir = _thumbs()
        out = out_dir / f"{name}.png"
    elif kind == "export" and fmt in ("stl", "3mf", "glb"):
        out_dir = _folder() / EXPORT_DIR
        suffix = re.sub(r"[^\w\- ]", "", str(suffix))[:30]
        out = None
    else:
        raise ModelError("この種類のファイルは受け付けていません")
    _check_out(data, fmt)
    out_dir.mkdir(parents=True, exist_ok=True)
    if out is None:
        out = _unique(out_dir / f"{name}{suffix}.{fmt}")
    _write_atomic(out, data)
    return {"path": str(out), "rel": f"{out.parent.name}/{out.name}", "file": out.name, "panel": _folder().name}


def blob_path(key: str) -> Path:
    """/blob/model/src-<名前> … 元の 3D ファイル / thumb-<名前> … 一覧の小さな画像。"""
    key = str(key)
    if key.startswith("thumb-"):
        p = _thumbs() / f"{_check_name(key[6:])}.png"
        if p.is_file():
            return p
        raise ModelError("ありません")
    if not key.startswith("src-"):
        raise ModelError("ありません")
    _, doc, _ = _read(key[4:])
    src = doc["source"]
    p = Path(src["path"]) if src else None
    if not p or p.suffix.lower() not in MODEL_EXTS or not p.is_file():
        raise ModelError("ありません")
    return p
