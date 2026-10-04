"""分类数据从下载到原子发布的可复现性、损坏检测和划分隔离。"""

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import acquire_quickdraw, file_record, verify_quickdraw
from modules.whiteboard.ink.dataset.classification.generate import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.classification.sources import reference_samples, TABLER_LABELS


class ClassificationPublicationTests(unittest.TestCase):
    """发布前必须完成文件校验，来源弱标签不得混入训练。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_decorated_tabler_line_is_not_a_plain_line_training_sample(self):
        records = []
        for name in sorted(set(TABLER_LABELS) | {"line.svg"}):
            paths = ([[[0, 0], [1, 1]], [[0, 0], [-1, 0], [0, 0]],
                      [[1, 1], [2, 1], [1, 1]]] if name == "line.svg" else [[[0, 0], [1, 1]]])
            records.append({"source": "tabler", "name": name, "split": "train",
                            "identifier": name, "group_id": name, "source_sha256": "a" * 64,
                            "paths": [{"points": path} for path in paths]})
        (self.root / "geometries.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")
        (self.root / "LICENSE.tabler").write_text("MIT License")
        manifest = {"dataset": "geometry-reference-v1",
                    "files": {name: file_record(self.root / name) for name in ("geometries.jsonl", "LICENSE.tabler")},
                    "tabler": {"files": {record["name"]: "a" * 64 for record in records}}}
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        samples = list(reference_samples(self.root, seed=7))
        self.assertTrue(samples)
        self.assertNotIn("line.svg", {sample["provenance"]["source_id"] for sample in samples})

    def test_small_download_is_flushed_verified_and_preserves_unrecognized(self):
        def response(url, timeout):
            if url.endswith("README.md"):
                body = b"https://creativecommons.org/licenses/by/4.0/"
            else:
                category = url.rsplit("/", 1)[1].split(".")[0]
                body = (json.dumps({"word": category, "recognized": False, "key_id": str(sum(map(ord, category))),
                                    "drawing": [[[0, 1, 2], [0, 1, 0]]]}) + "\n").encode()
            result = io.BytesIO(body)
            result.headers = {}
            return result
        with patch("modules.whiteboard.ink.dataset.classification.acquire.urllib.request.urlopen", side_effect=response):
            manifest = acquire_quickdraw(self.root / "source", 1)
        verify_quickdraw(self.root / "source")
        self.assertGreater(manifest["files"]["circle.ndjson"]["bytes"], 0)
        result = generate_dataset(self.root / "dataset", groups=1, quickdraw=self.root / "source")
        self.assertEqual(result["counts"]["splits"]["review"], 6)
        self.assertEqual(result["counts"]["quickdraw_recognized"], {"false": 6})

    def test_generation_is_byte_reproducible_and_corrupt_png_is_detected(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_dataset(first, seed=42, groups=3)
        generate_dataset(second, seed=42, groups=3)
        self.assertEqual(manifest["counts"]["samples"], 72)
        for file in first.rglob("*"):
            if file.is_file():
                self.assertEqual(file.read_bytes(), (second / file.relative_to(first)).read_bytes())
        row = json.loads((first / "train.jsonl").read_text().splitlines()[0])
        (first / row["image"]).write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "图片散列"):
            validate_dataset(first)

    def test_rehashed_wrong_split_is_rejected(self):
        directory = self.root / "dataset"
        generate_dataset(directory, seed=42, groups=3)
        rows = (directory / "train.jsonl").read_text().splitlines(keepends=True)
        (directory / "train.jsonl").write_text("".join(rows[1:]))
        with (directory / "test.jsonl").open("a") as output:
            output.write(rows[0])
        manifest = json.loads((directory / "manifest.json").read_text())
        for name in ("train.jsonl", "test.jsonl"):
            manifest["files"][name] = file_record(directory / name)
        (directory / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "来源组跨划分"):
            validate_dataset(directory)

    def test_failure_cleans_staging_and_existing_output_is_preserved(self):
        with patch("modules.whiteboard.ink.dataset.classification.generate.render_image", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                generate_dataset(self.root / "dataset", groups=1)
        self.assertEqual(list(self.root.iterdir()), [])
        destination = self.root / "existing"
        destination.mkdir()
        (destination / "keep").write_text("user")
        with self.assertRaises(ValueError):
            generate_dataset(destination, groups=1)
        self.assertEqual((destination / "keep").read_text(), "user")


if __name__ == "__main__":
    unittest.main()
