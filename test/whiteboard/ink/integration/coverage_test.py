"""v3追加发布保持旧数据及诊断隔离，参数索引与真实图片可逐例重放。"""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.dataset.classification.coverage import coverage_specs, diagnostic_specs, make_sample
from modules.whiteboard.ink.dataset.classification.coverage_package import (
    generate_coverage_dataset, generate_diagnostics, validate_coverage_dataset, validate_diagnostics,
)
from modules.whiteboard.ink.dataset.classification.generate import _counts, generate_dataset
from modules.whiteboard.ink.dataset.classification.sources import quickdraw_sample


class CoveragePublicationTests(unittest.TestCase):
    """真实文件和小型固定协议验证追加行为，不依赖下载资产或模型结果。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.parent = self.root / "parent"
        self.diagnostics = self.root / "diagnostics"
        generate_dataset(self.parent, seed=42, groups=2)
        generate_diagnostics(self.diagnostics)
        # 理想直线可能自然出现在未训练的review；保留原记录，禁止把它晋升为训练标签。
        with (self.diagnostics / "cases.jsonl").open() as handle:
            line = next(json.loads(row) for row in handle if '"diagnostic-line-0/native/width-3"' in row)
        sample = quickdraw_sample({"key_id": "123456", "word": "line", "recognized": True,
                                   "drawing": [[[0, 250], [0, 0]]]}, "line")
        image = f"images/{sample['sample_id']}.png"
        (self.parent / image).write_bytes((self.diagnostics / line["image"]).read_bytes())
        row = {"sample": sample, "image": image, "image_sha256": line["image_sha256"]}
        (self.parent / "review.jsonl").write_text(json.dumps(row) + "\n")
        parent_manifest = json.loads((self.parent / "manifest.json").read_text())
        parent_manifest["files"]["review.jsonl"] = file_record(self.parent / "review.jsonl")
        rows = []
        for split in ("train", "val", "test", "review"):
            with (self.parent / f"{split}.jsonl").open() as handle:
                rows.extend(json.loads(line) for line in handle)
        parent_manifest["counts"] = _counts(rows)
        (self.parent / "manifest.json").write_text(json.dumps(parent_manifest))
        selected = {}
        for spec in coverage_specs():
            if spec.label != "rectangle" or spec.parameters["width"] == spec.parameters["height"]:
                continue
            sample, _ = make_sample(spec, "closed", 3, 0)
            if sample["split"] in ("train", "val"):
                selected.setdefault(sample["split"], spec)
        self.patch = patch("modules.whiteboard.ink.dataset.classification.coverage_package.coverage_specs",
                           return_value=(*selected.values(), next(spec for spec in diagnostic_specs() if spec.name == "standard-square")))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temporary.cleanup()

    def test_append_is_reproducible_and_parent_rows_images_are_unchanged(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_coverage_dataset(self.parent, self.diagnostics, first)
        generate_coverage_dataset(self.parent, self.diagnostics, second)
        self.assertGreater(manifest["coverage"]["added_counts"]["splits"]["train"], 0)
        self.assertGreater(manifest["coverage"]["added_counts"]["splits"]["val"], 0)
        self.assertEqual(manifest["coverage"]["added_counts"]["splits"]["test"], 0)
        self.assertEqual(len(manifest["coverage"]["diagnostic_review_overlap"]), 1)
        self.assertEqual(manifest["coverage"]["parent_diagnostic_audit"]["verified_procedural_mother_groups"], 16)
        self.assertEqual(manifest["coverage"]["parent_diagnostic_audit"]["unmatched_groups"], [])
        for split in ("train", "val", "test", "review"):
            original = (self.parent / f"{split}.jsonl").read_bytes()
            current = (first / f"{split}.jsonl").read_bytes()
            self.assertTrue(current.startswith(original))
            if split in ("test", "review"):
                self.assertEqual(original, current)
        for path in (self.parent / "images").iterdir():
            self.assertEqual(path.read_bytes(), (first / "images" / path.name).read_bytes())
        for path in first.rglob("*"):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (second / path.relative_to(first)).read_bytes())
        with (first / "coverage-parameters.jsonl").open() as handle:
            parameters = [json.loads(line) for line in handle]
        self.assertEqual({p["stroke_width"] for p in parameters}, set(range(1, 7)))
        self.assertEqual({p["representation"] for p in parameters}, {"closed", "edge_middle", "separate_edges"})
        self.assertEqual({p["noise_severity"] for p in parameters}, {0, .002})
        self.assertFalse(any(p["case_name"] == "standard-square" for p in parameters))
        excluded = json.loads((first / "coverage-excluded.json").read_text())
        self.assertEqual(sum(p["case_name"] == "standard-square" for p in excluded), 36)
        validate_coverage_dataset(first, self.parent, self.diagnostics)

    def test_rehashed_parameter_tampering_is_rejected(self):
        destination = self.root / "data"
        generate_coverage_dataset(self.parent, self.diagnostics, destination)
        parameters = destination / "coverage-parameters.jsonl"
        lines = parameters.read_text().splitlines()
        record = json.loads(lines[0])
        record["parameters"]["width"] += 20
        lines[0] = json.dumps(record)
        parameters.write_text("\n".join(lines) + "\n")
        manifest = json.loads((destination / "manifest.json").read_text())
        manifest["files"][parameters.name] = file_record(parameters)
        (destination / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "参数复现"):
            validate_coverage_dataset(destination, self.parent, self.diagnostics)

    def test_diagnostics_cover_seven_classes_and_never_enter_training(self):
        counts = validate_diagnostics(self.diagnostics)
        self.assertEqual(counts["cases"], 108)
        self.assertEqual(counts["by_label"]["rectangle"], 36)
        with (self.diagnostics / "cases.jsonl").open() as handle:
            cases = [json.loads(line) for line in handle]
        square = next(c for c in cases if c["case_id"] == "standard-square/closed/width-3")
        self.assertEqual(square["parameters"], {"width": 240, "height": 240})
        diagnostic_hashes = {case["image_sha256"] for case in cases}
        destination = self.root / "data"
        generate_coverage_dataset(self.parent, self.diagnostics, destination)
        for split in ("train", "val", "test"):
            with (destination / f"{split}.jsonl").open() as handle:
                self.assertTrue(all(json.loads(line)["image_sha256"] not in diagnostic_hashes for line in handle))


if __name__ == "__main__":
    unittest.main()
