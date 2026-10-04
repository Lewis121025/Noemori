"""真实字符来源的解析、派生与负监督隔离契约。"""

import io
import unittest

import numpy as np
from PIL import Image, ImageDraw

from modules.whiteboard.ink.dataset.handwriting.parsers import integrate_velocity, parse_unipen
from modules.whiteboard.ink.dataset.handwriting.package import normalize_kanji, _isolate_duplicates
from modules.whiteboard.ink.dataset.handwriting.schema import character_split, digit_split, eligible_label, expected_identity


def unipen(strokes="0-1", label="4", comment="4 12 224"):
    return f''' .INCLUDE dene.doc
.SEGMENT DIGIT {strokes} ? "{label}"
.COMMENT {comment}
.PEN_DOWN
0 1
2 3
.PEN_UP
.DT 100
.PEN_DOWN
8 9
10 11
.PEN_UP
'''


class HandwritingTests(unittest.TestCase):
    """不能接笔、扭曲速度轴、混用局部作者编号或把原语字符当负例。"""

    def test_unipen_keeps_pen_up_and_original_identity(self):
        row = parse_unipen(unipen(), "train")[0]
        self.assertEqual(row["paths"], [[[0., -1.], [2., -3.]], [[8., -9.], [10., -11.]]])
        self.assertEqual((row["writer"], row["original_id"], row["label"]), (12, 224, "4"))

    def test_mismatched_labels_and_declared_stroke_counts_fail(self):
        for text in (unipen(strokes="0"), unipen(comment="8 12 224"), unipen().replace(".PEN_UP", ".PEN_DOWN", 1)):
            with self.assertRaises(ValueError):
                parse_unipen(text, "train")

    def test_official_digit_cohorts_namespace_locally_reused_writer_ids(self):
        a = expected_identity({"source": "pendigits", "cohort": "train", "local_writer_id": 12})
        b = expected_identity({"source": "pendigits", "cohort": "test", "local_writer_id": 12})
        self.assertNotEqual(a[0], b[0])
        self.assertEqual(b[2], "test")
        self.assertEqual(sum(digit_split("train", i) == "val" for i in range(1, 31)), 6)
        with self.assertRaises(ValueError):
            digit_split("test", 15)

    def test_velocity_restores_axis_units_before_integration(self):
        result = integrate_velocity(np.array([[1., 1., 0.], [0., 1., 1.], [2., 2., 2.]]), [2., 6., 5.])
        self.assertEqual(result, [[[2., -0.], [4., -6.], [4., -12.]]])
        for values in (np.zeros((3, 4)), np.full((3, 4), np.nan), np.zeros((2, 4))):
            with self.assertRaises(ValueError):
                integrate_velocity(values, [2., 6., 5.])

    def test_single_anonymous_english_writer_is_training_only(self):
        group, writer, split = expected_identity({"source": "character_trajectories"})
        self.assertIsNone(writer)
        self.assertEqual(split, "train")
        self.assertIn("single_anonymous_subject", group)

    def test_near_primitive_source_labels_are_excluded(self):
        for label in "01":
            self.assertFalse(eligible_label("pendigits", label))
        for label in "cdlopquvy":
            self.assertFalse(eligible_label("character_trajectories", label))
        for label in "一口囗〇丨丿":
            self.assertFalse(eligible_label("kuzushiji_kanji", label))
        self.assertTrue(eligible_label("pendigits", "8"))
        self.assertTrue(eligible_label("character_trajectories", "w"))
        self.assertTrue(eligible_label("kuzushiji_kanji", "語"))

    def test_kanji_isolation_is_by_source_character(self):
        self.assertEqual(character_split("U+8A9E"), character_split("U+8A9E"))
        group, writer, split = expected_identity({"source": "kuzushiji_kanji", "character_class": "U+8A9E"})
        self.assertEqual(group, "kuzushiji_kanji/U+8A9E")
        self.assertIsNone(writer)
        self.assertEqual(split, character_split("U+8A9E"))

    def test_kanji_preprocessing_inverts_and_preserves_aspect_ratio(self):
        image = Image.new("L", (64, 64), 0)
        ImageDraw.Draw(image).rectangle((10, 20, 50, 30), fill=255)
        data = io.BytesIO()
        image.save(data, format="PNG")
        output, info = normalize_kanji(data.getvalue())
        self.assertEqual((output.mode, output.size), ("RGB", (224, 224)))
        self.assertEqual(output.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(output.getpixel((112, 112)), (0, 0, 0))
        self.assertAlmostEqual(info["rendered_size"][0] / info["rendered_size"][1], 41 / 11, delta=.1)

    def test_duplicate_quarantine_preserves_assigned_writer_split(self):
        rows = [{"sample_id": str(i), "pixel_sha256": "same", "split": split,
                 "assigned_split": split, "label": "other"} for i, split in enumerate(("train", "test"))]
        excluded = _isolate_duplicates(rows)
        self.assertEqual(len(excluded), 2)
        self.assertEqual([r["assigned_split"] for r in rows], ["train", "test"])
        self.assertTrue(all(r["split"] == "review" and r["label"] is None for r in rows))
