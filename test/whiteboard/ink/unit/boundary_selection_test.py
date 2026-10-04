"""边界分层只影响抽样，不生成或借用分类标签。"""

import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.boundary.selection import protected_keys, stratification


class BoundarySelectionTests(unittest.TestCase):
    """验证真实原key保护兼容两代来源格式，完整路径与分层契约可观察。"""

    def test_axis_statistics_are_rotation_invariant_and_not_labels(self):
        values = []
        for rotation in (0, .6, 1.7):
            path = []
            for i in range(129):
                t = i * 2 * math.pi / 128
                x, y = 100 * math.cos(t), 78 * math.sin(t)
                path.append([x * math.cos(rotation) - y * math.sin(rotation), x * math.sin(rotation) + y * math.cos(rotation)])
            result = stratification([path])
            self.assertIsNotNone(result)
            self.assertFalse(result["label_evidence"])
            self.assertNotIn("label", result)
            values.append(result["axis_ratio"])
        self.assertLess(max(values) - min(values), 1e-7)
        self.assertIsNone(stratification([path, path]))
        self.assertIsNone(stratification([path[:40]]))

    def test_protection_collects_global_raw_keys_without_predictions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "records.jsonl"
            rows = [{"sample": {"provenance": {"kind": "quickdraw", "source_id": "123"}}},
                    {"provenance": {"source_key_id": "456"}}, {"source_key_id": "789"},
                    {"sample_id": "unrelated", "prediction": "circle"}]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows))
            keys, snapshots = protected_keys([path])
            self.assertEqual(keys, {"123", "456", "789"})
            self.assertEqual(snapshots[0]["quickdraw_records"], 3)


if __name__ == "__main__":
    unittest.main()
