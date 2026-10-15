"""test_model.py — モデルスケッチの api.py を、Hub を起動せずに確かめる（py -m unittest discover -s tests）。
画面側（three.js・manifold）の計算は、ブラウザでの確認（Playwright）で行う。"""
import importlib.util
import io
import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path


class _Store:
    def __init__(self):
        self.d = {}

    def get(self, scope, key, default=None):
        return self.d.get((scope, key), default)

    def set(self, scope, key, value):
        self.d[(scope, key)] = json.loads(json.dumps(value))


class _Ctx:
    pass


def _stl(n=1) -> bytes:
    return b"\0" * 80 + struct.pack("<I", n) + b"\0" * 50 * n


class ModelTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("hubmod_model_test", Path(__file__).resolve().parent.parent / "api.py")
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        self.tmp = Path(tempfile.mkdtemp())
        ctx = _Ctx()
        ctx.store, ctx.data_dir, ctx.config = _Store(), self.tmp / "data", {}
        ctx.host = _Ctx()
        ctx.host.config = {"modules": {"folders": {"root": str(self.tmp / "registries")}}}
        self.api.setup(ctx)
        self.src = self.tmp / "dl" / "箱.stl"
        self.src.parent.mkdir()
        self.src.write_bytes(_stl())
        self.glb = self.tmp / "dl" / "prop.glb"
        self.glb.write_bytes(b"glTF" + b"\0" * 20)

    def test_folder_and_guide(self):
        st = self.api.state()
        f = Path(st["folder"])
        self.assertEqual(f, self.tmp / "registries" / "Model Sketch")
        self.assertTrue((f / "MODEL_FORMAT.md").is_file())

    def test_add_files_never_overwrites_and_skips_others(self):
        other = self.tmp / "dl" / "memo.txt"
        other.write_text("x")
        r1 = self.api.add_files([str(self.src), str(other)])
        r2 = self.api.add_files([str(self.src)])
        self.assertEqual(r1["made"], ["箱"])
        self.assertEqual(r1["skipped"], ["memo.txt"])
        self.assertEqual(r2["made"], ["箱 (2)"])
        self.assertEqual(self.api.state()["current"], "箱 (2)")

    def test_glb_defaults_to_meters_y_up(self):
        name = self.api.add_files([str(self.glb)])["made"][0]
        doc = self.api.open_model(name)["doc"]
        self.assertEqual(doc["source"]["scale"], 1000.0)
        self.assertTrue(doc["source"]["upY"])

    def test_open_reports_missing_source(self):
        name = self.api.add_files([str(self.src)])["made"][0]
        self.src.unlink()
        self.assertTrue(self.api.open_model(name)["missing"])

    def test_new_model_without_source(self):
        r = self.api.new_model("game", "New model")
        self.assertEqual(r["name"], "New model")
        o = self.api.open_model(r["name"])
        self.assertIsNone(o["doc"]["source"])
        self.assertEqual(o["doc"]["purpose"], "game")
        self.assertIsNone(o["srcKey"])

    def test_normalize_keeps_good_parts_and_warns(self):
        doc, warn = self.api.normalize({
            "purpose": "game", "source": None,
            "params": {"gap": {"value": 9, "min": 0, "max": 1}, "bad name": 1},
            "steps": [{"op": "box", "id": "a", "size": [1, 2, 3]}, {"nope": 1}],
            "parts": {"a": {"color": "#FF0000"}, "b": {"color": "red"}},
            "pins": [{"id": 1, "p": [1, 2, 3], "text": "x"}, {"id": 1, "p": [0, 0, 0]}, {"p": "bad"}],
            "section": {"on": True, "axis": "q", "at": "5"},
            "measure": [{"axis": "z", "at": 3}, {"axis": "w"}],
        })
        self.assertEqual(doc["purpose"], "game")
        self.assertEqual(doc["params"]["gap"]["value"], 1)            # 範囲に収める
        self.assertNotIn("bad name", doc["params"])
        self.assertEqual(len(doc["steps"]), 1)
        self.assertEqual(doc["parts"]["a"]["color"], "#FF0000")
        self.assertNotIn("color", doc["parts"]["b"])
        self.assertEqual([p["id"] for p in doc["pins"]], [1, 2])     # 番号の重なりはずらす
        self.assertEqual(doc["section"], {"on": True, "axis": "z", "at": 5.0, "flip": False})
        self.assertEqual(len(doc["measure"]), 1)
        self.assertGreaterEqual(len(warn), 3)

    def test_paint_and_material_are_kept(self):
        doc, warn = self.api.normalize({"source": None, "parts": {"a": {"material": "metal"}, "b": {"material": "gold"}},
                                        "paint": [{"of": "a", "color": "#112233", "where": {"normal": "up"}},
                                                  {"color": None}, {"color": "red"}, "x"]})
        self.assertEqual(doc["parts"]["a"]["material"], "metal")
        self.assertNotIn("material", doc["parts"]["b"])
        self.assertEqual(doc["paint"], [{"color": "#112233", "of": "a", "where": {"normal": "up"}}, {"color": None}])
        self.assertEqual(len(warn), 2)

    def test_save_and_poll(self):
        name = self.api.add_files([str(self.src)])["made"][0]
        doc = self.api.open_model(name)["doc"]
        doc["steps"] = [{"op": "lid", "of": "base"}]
        r = self.api.save_model(name, doc)
        self.assertEqual(self.api.poll(name)["mtime"], r["mtime"])
        self.assertEqual(self.api.open_model(name)["doc"]["steps"], [{"op": "lid", "of": "base"}])

    def test_broken_json_is_reported(self):
        name = self.api.add_files([str(self.src)])["made"][0]
        (Path(self.api.state()["folder"]) / f"{name}.model.json").write_text("{", encoding="utf-8")
        with self.assertRaises(self.api.ModelError):
            self.api.open_model(name)

    def test_save_out_checks_format_and_never_overwrites(self):
        name = self.api.add_files([str(self.src)])["made"][0]
        a = self.api.save_out(_stl(2), name=name, kind="export", format="stl")
        b = self.api.save_out(_stl(2), name=name, kind="export", format="stl")
        self.assertNotEqual(a["file"], b["file"])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("3D/3dmodel.model", "<model/>")
        self.assertTrue(self.api.save_out(buf.getvalue(), name=name, kind="export", format="3mf")["file"].endswith(".3mf"))
        self.assertTrue(self.api.save_out(b"glTF\x02\0\0\0", name=name, kind="export", format="glb")["file"].endswith(".glb"))
        for bad in [(b"nope", "stl"), (b"nope", "3mf"), (b"nope", "glb"), (b"\x89PNG\r\n\x1a\n", "exe")]:
            with self.assertRaises(self.api.ModelError):
                self.api.save_out(bad[0], name=name, kind="export", format=bad[1])
        ai = self.api.save_out(json.dumps({"a": 1}).encode(), name=name, kind="ai", format="json")
        self.assertEqual(ai["rel"], f"_ai/{name}.json")

    def test_blob_only_gives_known_files(self):
        name = self.api.add_files([str(self.src)])["made"][0]
        self.assertEqual(self.api.blob_path(f"src-{name}"), self.src.resolve())
        for key in ("../x", "thumb-nothing", "src-../../etc"):
            with self.assertRaises(self.api.ModelError):
                self.api.blob_path(key)

    def test_delete_moves_sketch_and_ai_files_but_keeps_source_and_exports(self):
        import sys, types
        name = self.api.add_files([str(self.src)])["made"][0]
        folder = Path(self.api.state()["folder"])
        self.api.save_out(json.dumps({"a": 1}).encode(), name=name, kind="ai", format="json")
        self.api.save_out(b"\x89PNG\r\n\x1a\n" + b"0" * 8, name=name, kind="ai", format="png")
        self.api.save_out(b"\x89PNG\r\n\x1a\n" + b"0" * 8, name=name, kind="thumb", format="png")
        self.api.save_out(_stl(1), name=name, kind="export", format="stl")
        sys.modules["send2trash"] = None            # ごみ箱が使えない環境 → _to_delete へ
        try:
            r = self.api.delete_model(name)
        finally:
            sys.modules.pop("send2trash", None)
        self.assertEqual(sorted(r["trashed"]), sorted([f"{name}.model.json", f"_ai/{name}.png", f"_ai/{name}.json"]))
        self.assertEqual(r["keptExports"], [f"{name}.stl"])
        self.assertFalse((folder / f"{name}.model.json").exists())
        self.assertTrue((folder / "_to_delete" / f"{name}.model.json").exists())
        self.assertTrue(self.src.exists())                                  # 元のファイルは残る
        self.assertTrue((folder / "export" / f"{name}.stl").exists())       # 書き出しも残る
        self.assertNotIn(name, self.api.state()["files"])
        self.assertIsNone(self.api.state()["current"])
        with self.assertRaises(self.api.ModelError):
            self.api.blob_path(f"thumb-{name}")

    def test_delete_uses_recycle_bin_when_available(self):
        import sys, types
        name = self.api.add_files([str(self.src)])["made"][0]
        sent = []
        sys.modules["send2trash"] = types.SimpleNamespace(send2trash=lambda p: (sent.append(p), Path(p).unlink()))
        try:
            self.api.delete_model(name)
        finally:
            sys.modules.pop("send2trash", None)
        self.assertEqual([Path(p).name for p in sent], [f"{name}.model.json"])
        with self.assertRaises(self.api.ModelError):
            self.api.delete_model(name)

    def test_bad_names_rejected(self):
        for bad in ("a/b", "..", " x", "a:b"):
            with self.assertRaises(self.api.ModelError):
                self.api.open_model(bad)


if __name__ == "__main__":
    unittest.main()
