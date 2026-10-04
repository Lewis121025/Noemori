"""MMG 数据原子发布、书写者泄漏与重新计算散列后的语义损坏检查。"""

from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.dataset.gestures.generate import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.gestures.schema import LICENSE_QUOTE, WRITER_DEVICES


class GesturePublicationTests(unittest.TestCase):
    """小型来源夹具保留真实用户结构，隔离算法不依赖完整网络下载。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.readme = LICENSE_QUOTE.encode()
        with zipfile.ZipFile(self.sources / "mmg.zip", "w") as archive:
            archive.writestr("README.txt", self.readme)
            for writer, device in WRITER_DEVICES.items():
                for speed_index, speed in enumerate(("FAST", "SLOW")):
                    for label_index, label in enumerate(("line", "arrowhead", "I")):
                        height = int(writer) * 10 + label_index * 3 + speed_index
                        body = (f'<Gesture Name="{label}~01" Subject="{writer}" InputType="{device}" Speed="{speed}" NumPts="3">'
                                f'<Stroke index="1"><Point X="0" Y="0"/><Point X="40" Y="{height}"/>'
                                '<Point X="100" Y="17"/></Stroke></Gesture>')
                        name = f"{writer}-{device}-{speed}/{writer}-{device}-{speed.lower()}-{label}-01.xml"
                        archive.writestr(name, body)
        digest = file_record(self.sources / "mmg.zip")["sha256"]
        self.patches = ExitStack()
        for module in ("schema", "generate"):
            prefix = f"modules.whiteboard.ink.dataset.gestures.{module}"
            self.patches.enter_context(patch(prefix + ".MMG_SHA256", digest))
            self.patches.enter_context(patch(prefix + ".README_SHA256", hashlib.sha256(self.readme).hexdigest()))
        self.patches.enter_context(patch("modules.whiteboard.ink.dataset.gestures.generate.EXPECTED_XML_COUNT", 120))

    def tearDown(self):
        self.patches.close()
        self.temporary.cleanup()

    def test_publication_is_reproducible_and_real_writers_are_disjoint(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_dataset(self.sources, first)
        generate_dataset(self.sources, second)
        duplicates = manifest["cross_split_duplicate_exclusions"]
        self.assertGreater(duplicates, 0)
        self.assertEqual(manifest["counts"]["samples"] + duplicates, 80)
        self.assertEqual(manifest["excluded_records"], 40 + duplicates)
        excluded = json.loads((first / "excluded.json").read_text())
        duplicate_hashes = {r["image_sha256"] for r in excluded if r.get("exclusion_kind") == "cross_split_duplicate"}
        for split in ("train", "val", "test"):
            with (first / f"{split}.jsonl").open() as handle:
                self.assertTrue(all(json.loads(line)["image_sha256"] not in duplicate_hashes for line in handle))
        assignments = manifest["writer_assignments"]
        self.assertEqual({split: sum(value == split for value in assignments.values()) for split in ("train", "val", "test")},
                         {"train": 12, "val": 4, "test": 4})
        for split, writers in manifest["counts"]["writers"].items():
            self.assertTrue(all(assignments[writer] == split for writer in writers))
        for path in first.rglob("*"):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (second / path.relative_to(first)).read_bytes())
        self.assertEqual(validate_dataset(first), manifest["counts"])

    def test_rehashed_split_and_geometry_tampering_are_rejected(self):
        destination = self.root / "data"
        generate_dataset(self.sources, destination)
        train = destination / "train.jsonl"
        original = train.read_text()
        rows = original.splitlines()
        row = json.loads(rows[0])
        row["sample"]["split"] = "test"
        rows[0] = json.dumps(row)
        train.write_text("\n".join(rows) + "\n")
        manifest = json.loads((destination / "manifest.json").read_text())
        manifest["files"]["train.jsonl"] = file_record(train)
        (destination / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "书写者身份或划分"):
            validate_dataset(destination)
        rows = original.splitlines()
        row = json.loads(rows[0])
        row["sample"]["paths"][0][0][0] += 1
        rows[0] = json.dumps(row)
        train.write_text("\n".join(rows) + "\n")
        manifest["files"]["train.jsonl"] = file_record(train)
        (destination / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "原始 XML 索引"):
            validate_dataset(destination)

    def test_corrupt_image_missing_file_and_failed_publish_are_detected(self):
        destination = self.root / "data"
        generate_dataset(self.sources, destination)
        image = next((destination / "images").iterdir())
        image.write_bytes(b"bad image")
        with self.assertRaisesRegex(ValueError, "图片散列"):
            validate_dataset(destination)
        with self.assertRaises(ValueError):
            generate_dataset(self.sources, destination)
        with patch("modules.whiteboard.ink.dataset.gestures.generate.render_image", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                generate_dataset(self.sources, self.root / "failed")
        self.assertFalse((self.root / "failed").exists())
        self.assertFalse(list(self.root.glob(".classification-build-*")))


if __name__ == "__main__":
    unittest.main()
