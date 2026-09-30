"""固定来源目录、原子发布、样本完整性和来源族泄漏的离线集成验证。"""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from modules.whiteboard.ink.dataset.tabler.generate import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.tabler.sources import BASE_URL, REVISION, SOURCE_FAMILIES, _download, verify_sources


def source_fixture(root: Path) -> None:
    """建立完整的离线接口夹具；几何为测试自造内容，不作为真实来源交付。"""
    root.mkdir()
    records = []
    contents = {f"{name}.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="black"><path d="M2 3h8v7"/></svg>'
                for _, names in SOURCE_FAMILIES.values() for name in names}
    contents["LICENSE"] = "MIT License\nCopyright synthetic test fixture\n"
    for filename, text in contents.items():
        data = text.encode()
        (root / filename).write_bytes(data)
        records.append({"file": filename, "url": f"{BASE_URL}/{filename}", "status": "downloaded",
                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {"schema_version": 1, "revision": REVISION, "records": records, "failures": []}
    (root / "manifest.json").write_text(json.dumps(manifest))


class TablerDatasetIntegrationTests(unittest.TestCase):
    """外部来源必须可追溯，输出失败不能留下部分数据包。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        source_fixture(self.sources)

    def tearDown(self):
        self.temporary.cleanup()

    def test_full_source_generation_is_reproducible_and_license_is_retained(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_dataset(self.sources, first, seed=12, augmentations=1)
        generate_dataset(self.sources, second, seed=12, augmentations=1)
        for path in first.iterdir():
            self.assertEqual(path.read_bytes(), (second / path.name).read_bytes())
        self.assertEqual(manifest["counts"]["samples"], 320)
        self.assertEqual(manifest["counts"]["splits"], {"train": 240, "val": 40, "test": 40})
        self.assertEqual((first / "LICENSE.tabler").read_bytes(), (self.sources / "LICENSE").read_bytes())
        self.assertEqual(validate_dataset(first)["samples"], 320)

    def test_missing_or_changed_source_is_not_silently_skipped(self):
        (self.sources / "line.svg").write_text("modified")
        with self.assertRaisesRegex(ValueError, "完整性"):
            verify_sources(self.sources)
        with self.assertRaises(ValueError):
            generate_dataset(self.sources, self.root / "output", augmentations=1)
        self.assertFalse((self.root / "output").exists())

    def test_download_failure_is_recorded_without_a_partial_source_file(self):
        with patch("urllib.request.urlopen", side_effect=OSError("offline")) as request:
            record = _download("icons/outline/missing.svg", self.root)
        self.assertEqual(request.call_count, 3)
        self.assertEqual(record["status"], "failed")
        self.assertIn("offline", record["reason"])
        self.assertFalse((self.root / "missing.svg").exists())

    def test_failed_output_is_cleaned_and_existing_directory_is_preserved(self):
        destination = self.root / "output"
        with patch("modules.whiteboard.ink.dataset.tabler.generate.write_preview", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                generate_dataset(self.sources, destination, augmentations=1)
        self.assertEqual(list(self.root.iterdir()), [self.sources])
        destination.mkdir()
        (destination / "user.txt").write_text("keep")
        with self.assertRaises(ValueError):
            generate_dataset(self.sources, destination, augmentations=1)
        self.assertEqual((destination / "user.txt").read_text(), "keep")

    def test_rehashed_cross_split_sample_is_rejected(self):
        destination = self.root / "output"
        generate_dataset(self.sources, destination, augmentations=1)
        train, test = destination / "train.jsonl", destination / "test.jsonl"
        lines = train.read_text().splitlines(keepends=True)
        train.write_text(''.join(lines[1:]))
        test.write_text(test.read_text() + lines[0])
        manifest_path = destination / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for path in (train, test):
            manifest["files"][path.name] = {"bytes": path.stat().st_size,
                                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "跨划分"):
            validate_dataset(destination)


if __name__ == "__main__":
    unittest.main()
