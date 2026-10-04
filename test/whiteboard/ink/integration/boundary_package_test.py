"""边界来源筛选、完整盲审发布和冻结证据的一体化小夹具。"""

import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.boundary.package import make_candidates, publish_reviewed, validate_dataset
from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json
from modules.whiteboard.ink.dataset.classification.render import render_image
from modules.whiteboard.ink.dataset.real_shapes.quickdraw import assigned_split


class BoundaryPublicationTests(unittest.TestCase):
    """渲染进程使用显式测试替身；生产包另以真实Rust渲染器端到端验收。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.keys = {split: [str(i) for i in range(50000, 51000) if assigned_split(str(i)) == split][:3]
                     for split in ("train", "val", "test")}
        self.old_holdout = self.keys["val"][2]
        self.protected = self.root / "protected.jsonl"
        protected_keys = [str(i) for i in range(1, 10000)]
        self.protected.write_text("".join(json.dumps({"source_key_id": key}) + "\n" for key in protected_keys))
        rows = [{"key_id": self.old_holdout}] + [{"key_id": key} for key in protected_keys]
        for index, (split, position) in enumerate((("train", 0), ("train", 1), ("train", 2), ("val", 0), ("test", 0))):
            angles = [j * 2 * math.pi / 80 for j in range(81)]
            rows.append({"key_id": self.keys[split][position], "word": "circle", "recognized": False,
                         "drawing": [[[100 * math.cos(t) for t in angles],
                                      [(95-index*2) * math.sin(t) for t in angles], list(range(81))]]})
        raw = self.sources / "circle.ndjson"
        raw.write_text("".join(json.dumps(r) + "\n" for r in rows))
        write_json(self.sources / "manifest.json", {"license": "CC-BY-4.0", "files": {
            "circle.ndjson": {**file_record(raw), "records": len(rows), "url": "https://example.invalid/fixture"}}})
        renderer = self.root / "renderer-fixture"
        renderer.write_text("明确测试替身")

        def render_fixture(arguments, *, input, text, check):
            self.assertEqual(arguments, [str(renderer)])
            for request in map(json.loads, input.splitlines()):
                render_image(request["paths"], 3).save(request["output"])

        quotas = {s: {band: 10 for band in ("075_085", "085_093", "093_100")} for s in self.keys}
        self.candidates = self.root / "candidates"
        with patch("modules.whiteboard.ink.dataset.boundary.package.subprocess.run", side_effect=render_fixture):
            make_candidates(self.sources, [self.protected], renderer, self.candidates, quotas)
        self.selection = list(map(json.loads, (self.candidates / "selection.jsonl").read_text().splitlines()))
        self.decisions = self.root / "decisions.jsonl"
        decisions = []
        for row in self.selection:
            uncertain = row["source_key_id"] == self.keys["train"][2]
            decisions.append({"sample_id": row["sample_id"], "record_sha256": row["record_sha256"], "reviewer": "codex_visual",
                              "decision": "ambiguous" if uncertain else "accept", "label": None if uncertain else "ellipse",
                              "reason": "独立测试夹具决定，不从分层统计产生标签"})
        self.decisions.write_text("".join(json.dumps(d) + "\n" for d in decisions))

    def tearDown(self):
        self.temporary.cleanup()

    def test_new_holdout_and_complete_raw_identity_are_preserved(self):
        self.assertEqual(len(self.selection), 5)
        self.assertNotIn(self.old_holdout, {r["source_key_id"] for r in self.selection})
        self.assertTrue(all(r["record_line"] > 10000 for r in self.selection))
        self.assertTrue(all(len(r["paths"]) == 1 and len(r["paths"][0]) == 81 for r in self.selection))
        output = self.root / "final"
        manifest = publish_reviewed(self.candidates, self.decisions, output)
        self.assertEqual(validate_dataset(output), manifest["counts"])
        self.assertEqual(manifest["counts"]["splits"], {"train": 2, "val": 1, "test": 1, "review": 1})
        review = json.loads((output / "review.jsonl").read_text())
        self.assertIsNone(review["label"])
        self.assertEqual(review["group_id"], "quickdraw-key-" + review["provenance"]["source_key_id"])

    def test_partial_decisions_and_frozen_selection_mutation_are_rejected(self):
        self.decisions.write_text("\n".join(self.decisions.read_text().splitlines()[:-1]) + "\n")
        with self.assertRaisesRegex(ValueError, "覆盖完整"):
            publish_reviewed(self.candidates, self.decisions, self.root / "partial")
        with (self.candidates / "selection.jsonl").open("a") as handle:
            handle.write("\n")
        with self.assertRaisesRegex(ValueError, "固定候选"):
            publish_reviewed(self.candidates, self.decisions, self.root / "modified")

    def test_rehashed_supervised_label_change_cannot_override_visual_decision(self):
        output = self.root / "final"
        publish_reviewed(self.candidates, self.decisions, output)
        path = output / "train.jsonl"
        rows = list(map(json.loads, path.read_text().splitlines()))
        rows[0]["label"] = "circle"
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["files"][path.name] = file_record(path)
        write_json(output / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "独立视觉决定"):
            validate_dataset(output)


if __name__ == "__main__":
    unittest.main()
