import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import release_engineer as release
spec = importlib.util.spec_from_file_location("demo_worker", ROOT / "templates/ai-adapter/worker.py")
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"; self.root.mkdir()
        (self.root / "config").mkdir(); (self.root / "bin").mkdir()
        config = json.loads((ROOT / "config/package.json").read_text(encoding="utf-8"))
        config["entrypoints"] = ["bin/demo.py"]
        (self.root / "config/package.json").write_text(json.dumps(config), encoding="utf-8")
        (self.root / "VERSION").write_text("0.1.0\n", encoding="utf-8")
        (self.root / "bin/demo.py").write_text("print('demo')\n", encoding="utf-8")

    def archive(self, names):
        path = Path(self.temp.name) / "input.zip"
        with zipfile.ZipFile(path, "w") as z:
            for name, content in names:
                z.writestr(name, content)
        return path

    def test_cross_platform_paths_rejected(self):
        for name in ("../x", "/x", "C:/x", "x\\..\\y", "a//b", "a/./b", "NUL.txt", "x.", "a:stream", "a/*"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.safe_name(name)
        self.assertEqual(release.safe_name("src/café.py"), "src/café.py")

    def test_duplicate_case_archive_rejected(self):
        path = self.archive([("pkg/A.txt", "x"), ("pkg/a.txt", "y")])
        with self.assertRaises(ValueError): release.inspect_zip(path)

    def test_archive_traversal_never_extracted(self):
        path = self.archive([("../outside.txt", "x")])
        with self.assertRaises(ValueError): release.inspect_zip(path)
        self.assertFalse((Path(self.temp.name) / "outside.txt").exists())

    def test_symlink_archive_rejected(self):
        path = Path(self.temp.name) / "link.zip"
        with zipfile.ZipFile(path, "w") as z:
            info = zipfile.ZipInfo("pkg/link"); info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, "../../target")
        with self.assertRaises(ValueError): release.inspect_zip(path)

    def test_nested_archive_rejected(self):
        with self.assertRaises(ValueError): release.inspect_zip(self.archive([("pkg/inner.zip", b"data")]))

    def test_secret_scan_redacts_values(self):
        value = "gh" + "p_" + "a" * 36
        hits = release.screen("src/code.py", ("value='" + value + "'").encode())
        self.assertTrue(hits); self.assertNotIn(value, json.dumps(hits))
        self.assertTrue(release.screen(".env", b""))
        self.assertFalse(release.screen(".env.example", b"API_KEY=YOUR_API_KEY\n"))

    def test_secret_blocks_release(self):
        (self.root / "cookies.txt").write_text("not a live cookie", encoding="utf-8")
        with self.assertRaises(ValueError): release.build(self.root, Path(self.temp.name) / "out")
        self.assertFalse((Path(self.temp.name) / "out").exists())

    def test_redacted_scan_receipt_can_be_delivered(self):
        (self.root / "evidence").mkdir()
        (self.root / "evidence/SECRET-SCAN.json").write_text('{"status":"PASS","findings":[]}', encoding="utf-8")
        receipt = release.build(self.root, Path(self.temp.name) / "out")
        self.assertEqual(receipt["secret_scan"], "PASS_SIGNATURE_SCAN")
        self.assertTrue(release.screen("config/secrets.json", b"{}"))

    def test_output_inside_source_rejected(self):
        with self.assertRaises(ValueError): release.build(self.root, self.root / "out")

    def test_build_verify_and_reproducibility(self):
        a, b = Path(self.temp.name) / "out-a", Path(self.temp.name) / "out-b"
        first, second = release.build(self.root, a), release.build(self.root, b)
        self.assertEqual(first["archive_sha256"], second["archive_sha256"])
        self.assertTrue(release.verify_zip(a / first["zip"])["manifest_verified"])
        self.assertEqual(first["test_status"]["AUTH_VERIFIED"], "UNVERIFIED")
        self.assertFalse(first["callback"]["delivered_to_external_system"])

    def test_output_not_overwritten(self):
        out = Path(self.temp.name) / "out"; receipt = release.build(self.root, out)
        original = (out / receipt["zip"]).read_bytes()
        with self.assertRaises(ValueError): release.build(self.root, out)
        self.assertEqual(original, (out / receipt["zip"]).read_bytes())

    def test_manifest_detects_modified_file(self):
        out = Path(self.temp.name) / "out"; receipt = release.build(self.root, out)
        archive = out / receipt["zip"]
        with zipfile.ZipFile(archive) as z: files = {i.filename: z.read(i) for i in z.infolist()}
        files["ai-release-engineer/bin/demo.py"] = b"modified"
        with zipfile.ZipFile(archive, "w") as z:
            for name, data in files.items(): z.writestr(name, data)
        with self.assertRaises(ValueError): release.verify_zip(archive)

    def test_manifest_detects_untracked_file(self):
        out = Path(self.temp.name) / "out"; receipt = release.build(self.root, out)
        archive = out / receipt["zip"]
        with zipfile.ZipFile(archive, "a") as z: z.writestr("ai-release-engineer/unlisted.txt", "x")
        with self.assertRaises(ValueError): release.verify_zip(archive)

    def test_missing_entrypoint_rejected(self):
        (self.root / "bin/demo.py").unlink()
        with self.assertRaises(ValueError): release.build(self.root, Path(self.temp.name) / "out")

    def test_version_mismatch_rejected(self):
        (self.root / "VERSION").write_text("0.2.0\n")
        with self.assertRaises(ValueError): release.build(self.root, Path(self.temp.name) / "out")

    def test_size_limit(self):
        path = self.archive([("pkg/data.txt", b"abcd")])
        with patch.object(release, "MAX_FILE", 3), self.assertRaises(ValueError): release.inspect_zip(path)

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = json.loads((ROOT / "examples/task.json").read_text())

    def test_duplicate_returns_saved_result(self):
        first = worker.execute(self.task, self.root)
        self.task["attempt"] = 2
        second = worker.execute(self.task, self.root)
        self.assertFalse(first["reused"]); self.assertTrue(second["reused"])
        self.assertEqual(first["result"], second["result"])
        self.assertEqual(len(list(self.root.glob("*.json"))), 1)

    def test_identity_payload_conflict(self):
        worker.execute(self.task, self.root); self.task["payload"]["text"] = "other"
        with self.assertRaises(ValueError): worker.execute(self.task, self.root)

    def test_new_key_cannot_bypass_same_task(self):
        worker.execute(self.task, self.root); self.task["idempotency_key"] = "other"
        with self.assertRaises(ValueError): worker.execute(self.task, self.root)

    def test_stale_lock_never_executes(self):
        stem = worker.digest({k: self.task[k] for k in ("mission_id", "task_id")})
        (self.root / (stem + ".lock")).touch()
        result = worker.execute(self.task, self.root)
        self.assertEqual(result["status"], "UNCERTAIN")
        self.assertEqual(len(list(self.root.glob("*.json"))), 0)

    def test_interrupted_pending_is_not_retried(self):
        original_save = worker.save
        def interrupt_done(path, receipt):
            if receipt["status"] == "DONE": raise OSError("simulated interruption")
            return original_save(path, receipt)
        with patch.object(worker, "save", interrupt_done), self.assertRaises(OSError):
            worker.execute(self.task, self.root)
        result = worker.execute(self.task, self.root)
        self.assertEqual(result["status"], "UNCERTAIN")
        journal = json.loads(next(self.root.glob("*.json")).read_text())
        self.assertEqual(journal["status"], "PENDING")

    def test_task_identity_does_not_create_user_paths(self):
        self.task["mission_id"] = "../../outside"
        worker.execute(self.task, self.root)
        self.assertEqual(len(list(self.root.glob("*.json"))), 1)
        self.assertFalse((self.root.parent / "outside").exists())

    def test_contract_rejects_invalid_attempt(self):
        self.task["attempt"] = True
        with self.assertRaises(ValueError): worker.execute(self.task, self.root)

if __name__ == "__main__": unittest.main()
