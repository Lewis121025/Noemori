"""数据集发布、完整性核验和命令行端到端产物检查。"""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from modules.whiteboard.ink.dataset.generate import generate_dataset, validate_dataset


class DatasetPublicationTests(unittest.TestCase):
    """发布失败不留部分数据，公开目录可独立复核。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_generation_is_byte_reproducible_and_manifest_matches_data(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_dataset(first, seed=77, groups=20)
        generate_dataset(second, seed=77, groups=20)
        self.assertEqual(manifest["counts"]["samples"], 160)
        self.assertEqual(manifest["counts"]["preview_samples"], 84)
        self.assertEqual(sum(value.get("circle", 0) for value in manifest["counts"]["primitives"].values()), 8)
        self.assertEqual(sum(value.get("square", 0) for value in manifest["counts"]["primitives"].values()), 8)
        for path in first.iterdir():
            self.assertEqual(path.read_bytes(), (second / path.name).read_bytes())
        actual = validate_dataset(first)
        self.assertEqual(actual["samples"], 160)
        self.assertEqual(sum(actual["groups"].values()), 20)

    def test_nonempty_destination_is_never_overwritten(self):
        destination = self.root / "dataset"
        destination.mkdir()
        (destination / "user-data").write_text("keep")
        with self.assertRaises(ValueError):
            generate_dataset(destination, groups=1)
        self.assertEqual((destination / "user-data").read_text(), "keep")
        self.assertEqual(list(self.root.iterdir()), [destination])

    def test_failed_generation_leaves_no_published_or_temporary_dataset(self):
        with patch("modules.whiteboard.ink.dataset.generate.write_preview", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                generate_dataset(self.root / "dataset", groups=1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_modified_data_and_misleading_manifest_counts_are_rejected(self):
        destination = self.root / "dataset"
        generate_dataset(destination, groups=10)
        manifest_path = destination / "manifest.json"
        original = manifest_path.read_text()
        manifest = json.loads(original)
        manifest["counts"]["samples"] += 1
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "数量不符"):
            validate_dataset(destination)
        manifest_path.write_text(original)
        with (destination / "train.jsonl").open("a") as handle:
            handle.write("{}\n")
        with self.assertRaisesRegex(ValueError, "散列"):
            validate_dataset(destination)

    def test_rehashed_wrong_split_is_still_rejected_by_semantic_validation(self):
        destination = self.root / "dataset"
        generate_dataset(destination, groups=30)
        train = destination / "train.jsonl"
        test = destination / "test.jsonl"
        lines = train.read_text().splitlines(keepends=True)
        train.write_text("".join(lines[1:]))
        test.write_text(test.read_text() + lines[0])
        manifest_path = destination / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for path in (train, test):
            manifest["files"][path.name] = {"bytes": path.stat().st_size,
                                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "跨划分|划分错误"):
            validate_dataset(destination)

    def test_cli_generates_and_validates_an_offline_reviewable_dataset(self):
        destination = self.root / "dataset"
        command = [sys.executable, "-B", "-m", "modules.whiteboard.ink.dataset"]
        generated = subprocess.run([*command, "generate", "--output", str(destination), "--groups", "2"],
                                   cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(generated.stdout)["samples"], 16)
        verified = subprocess.run([*command, "validate", str(destination)],
                                  cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(verified.stdout)["samples"], 16)
        preview = (destination / "preview.html").read_text()
        self.assertIn("输入", preview)
        self.assertIn("应用标签后", preview)
        self.assertIn("<svg", preview)
        self.assertNotIn("https://", preview)


if __name__ == "__main__":
    unittest.main()
