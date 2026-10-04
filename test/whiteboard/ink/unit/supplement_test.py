"""真实负例补充必须可追溯，固定盲审样本和不确定标签不能混入监督。"""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.training.supplement import partition_negatives


class SupplementTests(unittest.TestCase):
    """以独立source ID隔离变体，不允许手工移动困难样本到训练集。"""

    def setUp(self):
        self.rows = [{"sample": {"sample_id": str(i), "split": "review",
                     "provenance": {"source_sha256": f"hash-{i}", "kind": "quickdraw", "source_id": str(i)}}}
                     for i in range(30)]
        self.decisions = [{"sample_id": str(i), "source_sha256": f"hash-{i}", "reviewer": "codex_visual",
                           "decision": "accept", "label": "other"} for i in range(30)]

    def test_stable_splits_and_unresolved_samples_are_excluded(self):
        self.decisions[0].update(decision="ambiguous", label=None)
        first = partition_negatives(self.rows, self.decisions, {"fixed"})
        second = partition_negatives(self.rows, list(reversed(self.decisions)), {"fixed"})
        ids = lambda rows: {row["sample"]["sample_id"] for row in rows}
        self.assertFalse(ids(first["train"]) & ids(first["val"]))
        self.assertEqual(len(first["train"]) + len(first["val"]), 29)
        for split in first:
            self.assertEqual(ids(first[split]), ids(second[split]))

    def test_overlap_changed_source_or_positive_label_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "相交"):
            partition_negatives(self.rows, self.decisions, {"2"})
        for key, value in (("source_sha256", "changed"), ("label", "circle")):
            changed = copy.deepcopy(self.decisions)
            changed[0][key] = value
            with self.assertRaises(ValueError):
                partition_negatives(self.rows, changed, set())


if __name__ == "__main__":
    unittest.main()
