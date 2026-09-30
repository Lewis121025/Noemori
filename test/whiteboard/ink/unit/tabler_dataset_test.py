"""SVG 导入的几何保真与显式失败、来源族划分和扩展样本契约。"""

import copy
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.tabler.samples import SourceGeometry, iter_samples
from modules.whiteboard.ink.dataset.tabler.schema import validate_sample
from modules.whiteboard.ink.dataset.tabler.sources import SOURCE_FAMILIES, source_assignment
from modules.whiteboard.ink.dataset.tabler.svg import parse_svg_text


def svg(content: str) -> str:
    """构造测试用无填充 SVG，避免依赖网络和真实下载产物。"""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="black">{content}</svg>'


def geometries() -> list[SourceGeometry]:
    """提供两个同划分的固定短路径，供契约测试使用；不冒充上游下载素材。"""
    paths = [[(-1.0 + index / 4, 0.0) for index in range(9)], [(0.0, index / 8) for index in range(9)]]
    return [SourceGeometry(filename, "a" * 64, source_assignment(filename)[0], "train", paths, 2, [])
            for filename in ("line.svg", "circle.svg")]


class SvgImportTests(unittest.TestCase):
    """有意义的几何锚点与子路径边界必须保留。"""

    def test_relative_commands_close_and_subpaths_preserve_corners(self):
        result = parse_svg_text(svg('<path d="M0 0h4v3h-4z M8 0l0 5"/>'))
        self.assertEqual(len(result.paths), 2)
        for vertex in ((0, 0), (4, 0), (4, 3), (0, 3)):
            self.assertIn(vertex, result.paths[0])
        self.assertEqual(result.paths[0][0], result.paths[0][-1])
        self.assertEqual(result.paths[1][0], (8, 0))
        self.assertEqual(result.paths[1][-1], (8, 5))

    def test_curve_arcs_and_transforms_are_handled_by_library(self):
        result = parse_svg_text(svg('<g transform="translate(3 4) scale(2)"><path d="M0 0C0 2 2 2 2 0"/></g>'))
        self.assertEqual(result.paths[0][0], (3, 4))
        self.assertEqual(result.paths[0][-1], (7, 4))
        self.assertIn((5, 7), result.paths[0])
        arc = parse_svg_text(svg('<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>')).paths[0]
        self.assertGreater(len(arc), 50)
        self.assertTrue(all(abs(math.hypot(x - 12, y - 12) - 9) < 1e-8 for x, y in arc))

    def test_basic_shapes_are_not_silently_ignored(self):
        result = parse_svg_text(svg('<circle cx="5" cy="5" r="2"/><rect x="10" y="2" width="4" height="6"/>'))
        self.assertEqual(result.shape_count, 2)
        self.assertEqual(len(result.paths), 2)
        self.assertTrue(all(abs(math.hypot(x - 5, y - 5) - 2) < 1e-8 for x, y in result.paths[0]))
        self.assertIn((14, 8), result.paths[1])

    def test_transparent_helper_is_explicitly_excluded(self):
        result = parse_svg_text(svg('<path d="M0 0h24v24H0z" stroke="none" fill="none"/><path d="M1 2h5"/>'))
        self.assertEqual(result.shape_count, 2)
        self.assertEqual(len(result.paths), 1)
        self.assertEqual(len(result.excluded), 1)
        self.assertEqual(result.excluded[0]["shape_index"], 0)

    def test_unsupported_visual_semantics_and_malformed_paths_fail(self):
        invalid = ['<text>x</text>', '<use href="#shape"/>', '<path d="M0 0h4" style="stroke:red"/>',
                   '<path d="M0 0h4" stroke-dasharray="1 2"/>', '<path d="M0 0h4v4z" fill="red"/>',
                   '<svg><path d="M0 0h4"/></svg>', '<path d="M0 0"/>', '<path d="M0 0 L"/>']
        for content in invalid:
            with self.subTest(content=content), self.assertRaises((ValueError, IndexError)):
                parse_svg_text(svg(content))
        with self.assertRaises(ValueError):
            parse_svg_text('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>')


class TablerContractTests(unittest.TestCase):
    """来源不能通过特征泄漏，同族素材及背景不能跨划分。"""

    def test_related_icons_and_all_augmentations_stay_together(self):
        for names in (("arrow-left.svg", "arrow-right.svg", "arrow-up.svg", "arrow-down.svg"),
                      ("square.svg", "diamond.svg", "rectangle.svg", "rectangle-vertical.svg"),
                      ("triangle.svg", "triangle-inverted.svg")):
            self.assertEqual(len({source_assignment(name) for name in names}), 1)
        all_names = [name for _, names in SOURCE_FAMILIES.values() for name in names]
        self.assertEqual(len(all_names), 40)
        self.assertEqual(len(set(all_names)), 40)
        samples = list(iter_samples(geometries(), 5, 3))
        self.assertEqual(len(samples), 48)
        self.assertEqual({split for split, _ in samples}, {"train"})
        for _, sample in samples:
            self.assertEqual(set(sample["input"]), {"focus_stroke_id", "strokes"})
            validate_sample(sample)

    def test_same_seed_is_deterministic_and_old_schema_is_not_modified(self):
        first = list(iter_samples(geometries(), 7, 1))
        self.assertEqual(first, list(iter_samples(geometries(), 7, 1)))
        self.assertNotEqual(first, list(iter_samples(geometries(), 8, 1)))
        from modules.whiteboard.ink.dataset.schema import validate_sample as validate_original
        with self.assertRaises(ValueError):
            validate_original(first[0][1])

    def test_wrong_provenance_cross_split_context_and_feature_leakage_fail(self):
        sample = list(iter_samples(geometries(), 7, 1))[1][1]
        cases = []
        invalid = copy.deepcopy(sample)
        invalid["input"]["source_file"] = "line.svg"
        cases.append(invalid)
        invalid = copy.deepcopy(sample)
        invalid["provenance"]["context_source_files"] = ["spiral.svg"]
        cases.append(invalid)
        invalid = copy.deepcopy(sample)
        invalid["provenance"]["source_revision"] = "main"
        cases.append(invalid)
        invalid = copy.deepcopy(sample)
        invalid["group_id"] = "wrong"
        cases.append(invalid)
        invalid = copy.deepcopy(sample)
        invalid["annotation"] = {"status": "confirmed"}
        cases.append(invalid)
        for invalid in cases:
            with self.assertRaises(ValueError):
                validate_sample(invalid)


if __name__ == "__main__":
    unittest.main()
