"""解析目标、空间一致抖动和完整连续轮廓的可观测几何不变量。"""

from collections import Counter
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.detail.geometry import CLASSES, CLOSED, clean_path, parent_specs
from modules.whiteboard.ink.dataset.detail.variants import spatial_jitter, variants
from modules.whiteboard.ink.dataset.detail.package import quarantine_reasons


def path_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


class DetailGeometryTests(unittest.TestCase):
    """验证标签确实来自已知母图，细节只影响规定部位而不破坏箭翼或圆弧开放性。"""

    def test_parent_splits_and_view_cardinality(self):
        parents = parent_specs()
        self.assertEqual(len(parents), 1120)
        for label in CLASSES:
            self.assertEqual(Counter(p["assigned_split"] for p in parents if p["label"] == label), {"train": 128, "val": 16, "test": 16})
        self.assertEqual(sum(10 if p["label"] in CLOSED else 8 for p in parents), 10240)
        self.assertTrue(all(.4 <= p["parameters"]["axis_ratio"] <= .8 for p in parents if p["label"] == "ellipse"))

    def test_spatial_jitter_is_bounded_and_revisited_points_match(self):
        path = [[0, 0], [10, 5], [20, -7], [10, 5], [0, 0]]
        for amplitude in (.005, .015, .03):
            transformed = spatial_jitter(path, 100, amplitude, [.2, 1.3, 2.1, .8])
            self.assertEqual(transformed[0], transformed[-1])
            self.assertEqual(transformed[1], transformed[3])
            self.assertTrue(all(math.dist(a, b) <= amplitude*100 + 1e-8 for a, b in zip(path, transformed)))

    def test_clean_arrow_visits_both_wings_and_stops_at_second_wing(self):
        parameters = {"label": "arrow", "size": 200, "rotation_degrees": 0,
                      "head_length_relative_size": .25, "head_half_width_relative_size": .15}
        points = clean_path(parameters)
        self.assertEqual(points[0], [-100, 0])
        self.assertEqual(points[-1], [50, 30])
        self.assertIn([50, -30], points)
        self.assertEqual(sum(p == [100, 0] for p in points), 2)

    def test_gaps_remove_exact_perimeter_fraction_only_from_closed_classes(self):
        for parent in parent_specs(10):
            clean = clean_path(parent["parameters"])
            views = variants(parent)
            gaps = [v for v in views if v["variant"]["kind"] == "gap"]
            self.assertEqual(len(gaps), 2 if parent["label"] in CLOSED else 0)
            for view in gaps:
                missing = view["variant"]["missing_fraction_of_perimeter"]
                self.assertAlmostEqual(path_length(view["paths"][0])/path_length(clean), 1-missing, places=7)
                self.assertNotEqual(view["paths"][0][0], view["paths"][0][-1])
            if parent["label"] == "arc":
                self.assertTrue(all(math.dist(v["paths"][0][0], v["paths"][0][-1]) > parent["parameters"]["size"]*.35 for v in views))

    def test_retraces_and_tails_preserve_original_path_and_have_declared_bounds(self):
        for parent in parent_specs(10):
            clean = clean_path(parent["parameters"])
            size = parent["parameters"]["size"]
            for view in variants(parent):
                definition, path = view["variant"], view["paths"][0]
                if definition["kind"] == "tail":
                    self.assertEqual(path[:len(clean)], clean)
                    self.assertAlmostEqual(path_length(path[len(clean)-1:])/size, definition["length_relative_size"], places=7)
                if definition["kind"] == "retrace":
                    self.assertTrue(all(point in path for point in clean))
                    if definition["offset_relative_size"] == 0:
                        self.assertTrue(all(point in clean for point in path))
                    else:
                        self.assertTrue(all(min(math.dist(point, source) for source in clean) <= size*.002+1e-7 for point in path))

    def test_clean_pixel_conflict_quarantines_all_pair_references(self):
        rows = [{"sample_id": "a", "assigned_split": "train", "pixel_sha256": "clean", "clean_pixel_sha256": "clean"},
                {"sample_id": "b", "assigned_split": "train", "pixel_sha256": "jitter", "clean_pixel_sha256": "clean"},
                {"sample_id": "c", "assigned_split": "test", "pixel_sha256": "other", "clean_pixel_sha256": "other"}]
        self.assertEqual(set(quarantine_reasons(rows, {"clean"})), {"a", "b"})
        rows.append({"sample_id": "d", "assigned_split": "val", "pixel_sha256": "clean", "clean_pixel_sha256": "new"})
        self.assertEqual(set(quarantine_reasons(rows, set())), {"a", "b", "d"})


if __name__ == "__main__":
    unittest.main()
