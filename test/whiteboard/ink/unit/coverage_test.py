"""明确参数的干净几何覆盖与静态笔画表示契约。"""

import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.coverage import (
    GeometrySpec, coverage_specs, diagnostic_specs, make_paths, make_sample,
)
from modules.whiteboard.ink.dataset.classification.schema import split_for_group, validate_sample


class CleanCoverageTests(unittest.TestCase):
    """先验证参数几何和组隔离，不用分类器预测反过来选择训练样本。"""

    def test_square_and_near_square_have_requested_geometry(self):
        for height in (250, 240, 125):
            spec = GeometrySpec("test", "rectangle", {"width": 250, "height": height}, 0)
            path = make_paths(spec, "closed")[0]
            self.assertEqual(path[0], path[-1])
            self.assertAlmostEqual(max(p[0] for p in path) - min(p[0] for p in path), 250)
            self.assertAlmostEqual(max(p[1] for p in path) - min(p[1] for p in path), height)

    def test_integer_and_float_parameters_are_the_same_source_group(self):
        a = GeometrySpec("a", "rectangle", {"width": 240, "height": 240}, 0)
        b = GeometrySpec("b", "rectangle", {"width": 240.0, "height": 240.0}, 0.0)
        first, _ = make_sample(a, "closed", 3, 0)
        second, _ = make_sample(b, "closed", 3, 0)
        self.assertEqual(first["group_id"], second["group_id"])

    def test_edge_middle_start_changes_presentation_not_shape(self):
        spec = GeometrySpec("test", "rectangle", {"width": 250, "height": 240}, 0)
        closed = make_paths(spec, "closed")
        middle = make_paths(spec, "edge_middle")
        edges = make_paths(spec, "separate_edges")
        self.assertEqual(len(edges), 4)
        self.assertEqual(set(map(tuple, closed[0])), set(map(tuple, middle[0])))
        self.assertEqual(set(map(tuple, closed[0])), {tuple(p) for path in edges for p in path})
        self.assertEqual(middle[0][0], [0.0, -120.0])
        self.assertEqual(middle[0][0], middle[0][-1])

    def test_presentations_widths_and_noise_share_group_and_are_reproducible(self):
        spec = next(spec for spec in coverage_specs() if spec.label == "rectangle")
        groups = set()
        ids = set()
        for mode in ("closed", "edge_middle", "separate_edges"):
            for width in range(1, 7):
                for variant in (0, 1):
                    sample, metadata = make_sample(spec, mode, width, variant)
                    validate_sample(sample)
                    self.assertEqual((sample, metadata), make_sample(spec, mode, width, variant))
                    groups.add(sample["group_id"])
                    ids.add(sample["sample_id"])
                    self.assertEqual(sample["split"], split_for_group(sample["group_id"]))
                    if mode != "separate_edges":
                        self.assertEqual(sample["paths"][0][0], sample["paths"][0][-1])
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(ids), 36)

    def test_coverage_includes_missing_ratios_and_diagnostics_have_explicit_standard_square(self):
        rectangles = [spec for spec in coverage_specs() if spec.label == "rectangle"]
        ratios = {spec.parameters["width"] / spec.parameters["height"] for spec in rectangles}
        self.assertIn(1, ratios)
        self.assertGreaterEqual(sum(1 < ratio < 1.1 for ratio in ratios), 5)
        self.assertIn(0, {spec.rotation_degrees for spec in rectangles})
        diagnostics = list(diagnostic_specs())
        self.assertEqual({spec.label for spec in diagnostics}, {"line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow"})
        square = next(spec for spec in diagnostics if spec.name == "standard-square")
        self.assertEqual(square.parameters, {"width": 240, "height": 240})
        self.assertEqual(square.rotation_degrees, 0)

    def test_rotation_preserves_rectangle_side_lengths(self):
        spec = GeometrySpec("rotated", "rectangle", {"width": 250, "height": 240}, 37)
        paths = make_paths(spec, "separate_edges")
        lengths = [math.dist(path[0], path[-1]) for path in paths]
        for actual, expected in zip(lengths, (250, 240, 250, 240)):
            self.assertAlmostEqual(actual, expected, places=6)

    def test_explicit_ellipse_boundary_grid_covers_missing_axis_ratios(self):
        ellipses = [spec for spec in coverage_specs() if spec.name.startswith("ellipse-boundary-")]
        self.assertEqual(len(ellipses), 56)
        ratios = {round(spec.parameters["ry"] / spec.parameters["rx"], 2) for spec in ellipses}
        self.assertEqual(ratios, {.82, .86, .88, .9, .92, .94, .96})
        self.assertTrue(all(spec.label == "ellipse" for spec in ellipses))


if __name__ == "__main__":
    unittest.main()
