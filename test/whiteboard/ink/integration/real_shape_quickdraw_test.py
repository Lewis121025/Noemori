"""真实圈弧从原始来源、固定盲审到发布的完整契约。"""

import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json
from modules.whiteboard.ink.dataset.real_shapes.quickdraw import (
    assigned_split, generate_candidates, make_review_batch, publish_reviewed, validate_quickdraw, _counts,
)


class RealQuickDrawPublicationTests(unittest.TestCase):
    """使用明确的夹具几何标签检验隔离，不从生产规则产生评价标签。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        sources = self.root / "sources"
        sources.mkdir()
        protected = self.root / "protected"
        protected.mkdir()
        keys = {split: [str(i) for i in range(100, 1000) if assigned_split(str(i)) == split][:3]
                for split in ("train", "val", "test")}
        self.protected_key = keys["train"][2]
        (protected / "review.jsonl").write_text(json.dumps({"sample": {"provenance": {
            "kind": "quickdraw", "source_id": self.protected_key}}}) + "\n")
        files = {}
        for category in ("circle", "rainbow"):
            records = []
            for offset, split in enumerate(keys):
                selected = keys[split][0 if category == "circle" else 1]
                angles = [j * (2 * math.pi if category == "circle" else 2.2 + offset / 10) / 64 for j in range(65)]
                # 亚像素坐标保留不同源图，避免夹具意外生成跨split完全相同的栅格。
                xs = [100 * math.cos(t + offset / 5) for t in angles]
                ys = [100 * math.sin(t + offset / 5) for t in angles]
                strokes = [[xs, ys, list(range(65))]]
                if category == "rainbow":
                    strokes.append([[x + 30 for x in xs], [y + 10 for y in ys], list(range(65))])
                records.append({"word": category, "key_id": selected, "recognized": False, "drawing": strokes})
            if category == "circle":
                records.append({**records[0], "key_id": self.protected_key})
            path = sources / f"{category}.ndjson"
            path.write_text("".join(json.dumps(r) + "\n" for r in records))
            files[path.name] = {**file_record(path), "records": len(records), "url": "https://example.invalid/fixture"}
        readme = sources / "SOURCE_README.txt"
        readme.write_text("CC BY 4.0 fixture")
        files[readme.name] = file_record(readme)
        write_json(sources / "manifest.json", {"license": "CC-BY-4.0", "files": files})
        self.candidates = self.root / "candidates"
        generate_candidates(sources, protected, self.candidates)
        self.batch = self.root / "batch"
        make_review_batch(self.candidates, self.batch)
        self.selection = list(map(json.loads, (self.batch / "selection.jsonl").read_text().splitlines()))
        self.decisions = [{"sample_id": r["sample_id"], "record_sha256": r["record_sha256"],
                           "label": "circle" if r["source_label"] == "circle" else "arc", "decision": "accept",
                           "reason": "独立夹具标签", "reviewer": "codex_visual"} for r in self.selection]
        self._write_decisions()

    def tearDown(self):
        self.temporary.cleanup()

    def _write_decisions(self):
        (self.batch / "decisions.jsonl").write_text("".join(json.dumps(r) + "\n" for r in self.decisions))

    def test_source_protection_and_complete_strokes_holdout_isolation(self):
        rows = [json.loads(line) for split in ("train", "val", "test", "review")
                for line in (self.candidates / f"{split}.jsonl").read_text().splitlines()]
        self.assertNotIn(self.protected_key, {r["provenance"]["source_key_id"] for r in rows})
        self.assertTrue(all(r["label"] is None for r in rows if r["assigned_split"] != "train"))
        arcs = [r for r in rows if r["source_label"] == "rainbow"]
        self.assertEqual(len(arcs), 6)
        self.assertTrue(all(len(r["paths"]) == 1 and len(r["paths"][0]) == 65 for r in arcs))
        self.assertEqual(len({r["source_key_id"] for r in self.selection}), 4)

    def test_reviewed_publication_keeps_original_assignments_and_evidence(self):
        final = self.root / "final"
        manifest = publish_reviewed(self.candidates, [self.batch], final)
        self.assertEqual(validate_quickdraw(final), manifest["counts"])
        self.assertEqual(manifest["counts"]["splits"], {"train": 3, "val": 2, "test": 2, "review": 2})
        for split in ("val", "test"):
            rows = list(map(json.loads, (final / f"{split}.jsonl").read_text().splitlines()))
            self.assertEqual({r["label"] for r in rows}, {"circle", "arc"})
            self.assertTrue(all(r["annotation_kind"] == "ai_visual_review" and r["assigned_split"] == split for r in rows))

    def test_frozen_selection_incomplete_decisions_and_wrong_record_hash_are_rejected(self):
        self.decisions[0]["record_sha256"] = "0" * 64
        self._write_decisions()
        with self.assertRaisesRegex(ValueError, "盲审来源"):
            publish_reviewed(self.candidates, [self.batch], self.root / "wrong_hash")
        self.decisions.pop()
        self._write_decisions()
        with self.assertRaisesRegex(ValueError, "覆盖完整"):
            publish_reviewed(self.candidates, [self.batch], self.root / "incomplete")
        with (self.batch / "selection.jsonl").open("a") as handle:
            handle.write("\n")
        with self.assertRaisesRegex(ValueError, "固定选择"):
            publish_reviewed(self.candidates, [self.batch], self.root / "changed_selection")

    def test_rehashed_label_must_still_match_independent_review_decision(self):
        final = self.root / "final"
        publish_reviewed(self.candidates, [self.batch], final)
        path = final / "val.jsonl"
        rows = list(map(json.loads, path.read_text().splitlines()))
        rows[0]["label"] = "arrow"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        manifest = json.loads((final / "manifest.json").read_text())
        manifest["files"]["val.jsonl"] = file_record(path)
        all_rows = [json.loads(line) for split in ("train", "val", "test", "review")
                    for line in (final / f"{split}.jsonl").read_text().splitlines()]
        manifest["counts"] = _counts(all_rows)
        write_json(final / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "盲审决定"):
            validate_quickdraw(final)


if __name__ == "__main__":
    unittest.main()
