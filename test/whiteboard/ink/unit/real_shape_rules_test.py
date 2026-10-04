"""几何规则只产生有明确限制的训练弱标签，不把提示词当真值。"""

import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.real_shapes.rules import geometry_evidence


class RealShapeRuleTests(unittest.TestCase):
    """拒绝椭圆、直线、完整圆冒充弧及不完整弧冒充圆。"""

    def test_complete_circle_and_open_arc_have_distinct_rule_evidence(self):
        circle = [[[100*math.cos(i*math.tau/128), 100*math.sin(i*math.tau/128)] for i in range(129)]]
        arc = [[[100*math.cos(i*math.pi/128), 100*math.sin(i*math.pi/128)] for i in range(129)]]
        self.assertTrue(geometry_evidence(circle, "circle")["accepted"])
        self.assertFalse(geometry_evidence(circle, "arc")["accepted"])
        self.assertTrue(geometry_evidence(arc, "arc")["accepted"])
        self.assertFalse(geometry_evidence(arc, "circle")["accepted"])

    def test_ellipse_line_multi_stroke_and_decorated_shape_are_not_circle_truth(self):
        ellipse = [[[100*math.cos(i*math.tau/128), 70*math.sin(i*math.tau/128)] for i in range(129)]]
        line = [[[i, 0] for i in range(30)]]
        for paths in (ellipse, line, ellipse + [[[0,0],[1,1]]]):
            self.assertFalse(geometry_evidence(paths, "circle")["accepted"])
        self.assertFalse(geometry_evidence(line, "arc")["accepted"])


if __name__ == "__main__":
    unittest.main()
