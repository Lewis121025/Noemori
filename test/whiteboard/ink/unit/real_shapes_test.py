"""真实HDS标注和栅格输入契约，近圆与宽泛other标签不得自动变成监督。"""

import io
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.real_shapes.schema import hds_split, parse_vertices, resolve_label
from modules.whiteboard.ink.dataset.real_shapes.raster import normalize_image


class HdsAnnotationTests(unittest.TestCase):
    """作者类别与目标顶点各保留独立证据；拒绝猜测原始母图编号。"""

    def test_author_recommended_writer_split(self):
        for writer in ("u01", "u17", "u18", "u19"):
            self.assertEqual(hds_split(writer), "test")
        for writer in ("crt", "il1", "lts", "mrt", "nae"):
            self.assertEqual(hds_split(writer), "val")
        self.assertEqual(hds_split("aly"), "train")
        self.assertEqual(hds_split("if8"), "train")

    def test_ellipse_axes_are_unordered_and_near_circle_is_review_only(self):
        elongated = [[.1, .5], [.5, .7], [.9, .5], [.5, .3]]
        a = resolve_label("ellipse", elongated)
        b = resolve_label("ellipse", [elongated[i] for i in (2, 0, 3, 1)])
        self.assertEqual(a, b)
        self.assertEqual(a["label"], "ellipse")
        self.assertAlmostEqual(a["axis_ratio"], .5)
        near = resolve_label("ellipse", [[.1, .5], [.5, .87], [.9, .5], [.5, .13]])
        self.assertIsNone(near["label"])
        self.assertEqual(near["status"], "ambiguous")
        circle = resolve_label("ellipse", [[.1, .5], [.5, .9], [.9, .5], [.5, .1]])
        self.assertIsNone(circle["label"])

    def test_human_rectangles_and_triangles_map_but_other_does_not(self):
        rectangle = [[.1, .1], [.9, .1], [.9, .8], [.1, .8]]
        triangle = [[.1, .9], [.5, .1], [.9, .9]]
        self.assertEqual(resolve_label("rectangle", rectangle)["label"], "rectangle")
        self.assertEqual(resolve_label("triangle", triangle)["label"], "triangle")
        self.assertIsNone(resolve_label("other", None)["label"])

    def test_corrupt_or_invalid_vertices_are_rejected(self):
        self.assertEqual(parse_vertices(b"0.1,0.2\n0.9,0.2\n0.5,0.8\n", "triangle"), [[.1,.2],[.9,.2],[.5,.8]])
        for value in (b"nan,0.2\n0.9,0.2\n0.5,0.8", b"1.1,0.2\n0.9,0.2\n0.5,0.8", b"0.1,0.2,0.3", b"0.1,0.2"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_vertices(value, "triangle")

    def test_source_triangle_can_repeat_first_vertex_to_close_polygon(self):
        points = parse_vertices(b"0.32,0.83\n0.46,0.08\n0.67,0.87\n0.32,0.83", "triangle")
        self.assertEqual(len(points), 4)
        self.assertEqual(points[0], points[-1])
        self.assertEqual(resolve_label("triangle", points)["label"], "triangle")
        with self.assertRaises(ValueError):
            parse_vertices(b"0.32,0.83\n0.46,0.08\n0.67,0.87\n0.8,0.2", "triangle")

    def test_raster_keeps_aspect_ratio_and_exact_raw_vertices_space(self):
        original = Image.new("RGBA", (70, 70), (255,255,255,255))
        ImageDraw.Draw(original).rectangle((10, 25, 60, 45), outline=(0,0,0,255), width=2)
        buf = io.BytesIO(); original.save(buf, format="PNG")
        image, info = normalize_image(buf.getvalue())
        self.assertEqual(image.size, (224,224))
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(info["source_size"], [70,70])
        self.assertEqual(info["source_ink_bbox"], [10,25,61,46])
        self.assertAlmostEqual(info["rendered_size"][0] / info["rendered_size"][1], 51/21, delta=.04)
        self.assertEqual(info["padding"], 16)


if __name__ == "__main__":
    unittest.main()
