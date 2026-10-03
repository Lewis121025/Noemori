"""原生 SVG 几何必须保留解析参数，禁止借助折线采样替代曲线。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from modules.whiteboard.ink.dataset.native.geometry import (
    bounds,
    normalize_pair,
    parse_path,
    parse_svg,
    transform,
)


class NativeGeometryTests(unittest.TestCase):
    """覆盖命令保留、精确归一化、SVG 变换和严格拒绝旧点列。"""

    def test_curve_commands_remain_native(self):
        shape = parse_path("M 0 0 Q 1 2 3 0 C 4 2 5 2 6 0 A 2 1 30 0 1 8 0 Z")
        self.assertEqual(
            [c["op"] for c in shape["paths"][0]["commands"]], ["M", "Q", "C", "A", "Z"]
        )
        self.assertNotIn("points", repr(shape))
        self.assertEqual(shape["paths"][0]["commands"][1]["args"], [1.0, 2.0, 3.0, 0.0])

    def test_circle_stays_arcs_and_bezier_keeps_controls(self):
        circle = parse_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="black"><circle cx="12" cy="12" r="9"/></svg>'
        )
        commands = [c for p in circle["paths"] for c in p["commands"]]
        self.assertTrue(any(c["op"] == "A" for c in commands))
        self.assertFalse(any(c["op"] == "L" for c in commands))
        self.assertLessEqual(len(commands), 6)

    def test_normalization_uses_curve_extrema_and_shared_source_frame(self):
        source = parse_path("M 10 20 Q 20 60 30 20")
        target = parse_path("M 8 20 Q 20 64 32 20")
        pair, frame = normalize_pair(source, target)
        self.assertAlmostEqual(frame["scale"], 20.0)
        self.assertAlmostEqual(frame["center"][1], 30.0)
        self.assertEqual(
            pair["input"]["paths"][0]["commands"][1]["args"], [0.0, 1.5, 0.5, -0.5]
        )
        self.assertLess(pair["target"]["paths"][0]["commands"][0]["args"][0], -0.5)
        self.assertEqual(bounds(pair["input"]), (-0.5, -0.5, 0.5, 0.5))

    def test_translation_uniform_scale_leave_same_normalized_parameters(self):
        shape = parse_path("M 0 0 C 1 4 3 -2 4 1 A 2 1 25 0 1 6 2")
        shifted = transform(shape, scale=17.0, offset=(93.0, -21.0))
        a, _ = normalize_pair(shape, shape)
        b, _ = normalize_pair(shifted, shifted)
        for p, q in zip(a["input"]["paths"], b["input"]["paths"]):
            for c, d in zip(p["commands"], q["commands"]):
                self.assertEqual(c["op"], d["op"])
                for x, y in zip(c["args"], d["args"]):
                    self.assertAlmostEqual(x, y, places=10)

    def test_unsupported_svg_and_legacy_points_fail_explicitly(self):
        with self.assertRaises(ValueError):
            normalize_pair(
                {"paths": [{"points": [[0, 0], [1, 1]], "closed": False}]},
                {"paths": []},
            )
        with self.assertRaises(ValueError):
            parse_svg('<svg xmlns="http://www.w3.org/2000/svg"><text>abc</text></svg>')

    def test_relative_shorthand_and_transform_expand_without_sampling(self):
        shape = parse_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="black"><g transform="translate(10,20) scale(2)"><path d="m0 0q1 2 2 0t2 0"/></g></svg>'
        )
        commands = shape["paths"][0]["commands"]
        self.assertEqual([c["op"] for c in commands], ["M", "Q", "Q"])
        self.assertEqual(commands[-1]["args"], [16.0, 16.0, 18.0, 20.0])


if __name__ == "__main__":
    unittest.main()
