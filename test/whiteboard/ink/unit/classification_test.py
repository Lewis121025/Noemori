"""分类数据的标签、静态呈现与来源隔离契约。"""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.render import render_image
from modules.whiteboard.ink.dataset.classification.schema import validate_sample
from modules.whiteboard.ink.dataset.classification.sources import synthetic_samples, quickdraw_sample


class ClassificationContractTests(unittest.TestCase):
    """不把提示词当人工确认标签，不让绘制顺序或缩放扭曲类别。"""

    def test_render_preserves_aspect_ratio_and_is_order_independent(self):
        paths = [[[0, 0], [200, 0]], [[200, 0], [200, 50]],
                 [[200, 50], [0, 50]], [[0, 50], [0, 0]]]
        first = render_image(paths)
        second = render_image([list(reversed(path)) for path in reversed(paths)])
        self.assertEqual(first.tobytes(), second.tobytes())
        from PIL import ImageChops
        box = ImageChops.invert(first).getbbox()
        self.assertGreater((box[2] - box[0]) / (box[3] - box[1]), 3.5)
        self.assertEqual(first.size, (224, 224))
        self.assertEqual(first.mode, "RGB")

    def test_synthetic_is_reproducible_complete_and_grouped_before_augmentation(self):
        first = list(synthetic_samples(9, 4))
        self.assertEqual(first, list(synthetic_samples(9, 4)))
        self.assertEqual(len(first), 8 * 4 * 3)
        groups = {}
        for sample in first:
            validate_sample(sample)
            self.assertEqual(groups.setdefault(sample["group_id"], sample["split"]), sample["split"])
        self.assertEqual(len(groups), 8 * 4)
        rectangle = next(s for s in first if s["label"] == "rectangle")
        self.assertEqual(len(rectangle["paths"]), 4)
        arrow = next(s for s in first if s["label"] == "arrow")
        self.assertEqual(len(arrow["paths"]), 2)

    def test_prompt_and_recognized_do_not_make_a_confirmed_label(self):
        record = {"key_id": "123", "word": "circle", "recognized": False,
                  "drawing": [[[0, 3, 2], [0, 1, 3]]]}
        sample = quickdraw_sample(record, "circle")
        self.assertEqual(sample["split"], "review")
        self.assertEqual(sample["label_status"], "prompt_unreviewed")
        self.assertIs(sample["provenance"]["recognized"], False)
        validate_sample(sample)
        sample["split"] = "train"
        with self.assertRaises(ValueError):
            validate_sample(sample)

    def test_unknown_fields_nonfinite_values_and_empty_geometry_are_rejected(self):
        source = next(synthetic_samples(1, 1))
        for value in (float("nan"), float("inf"), True, "1", 10 ** 1000):
            sample = copy.deepcopy(source)
            sample["paths"][0][0][0] = value
            with self.assertRaises(ValueError):
                validate_sample(sample)
        for key, value in (("paths", []), ("label", "square"), ("split", "review"),
                           ("label_status", "confirmed"), ("time", 123)):
            sample = copy.deepcopy(source)
            sample[key] = value
            with self.assertRaises(ValueError):
                validate_sample(sample)

    def test_quickdraw_mismatched_coordinates_or_prompt_are_rejected(self):
        record = {"key_id": "123", "word": "circle", "recognized": True,
                  "drawing": [[[0, 1], [0]]]}
        with self.assertRaises(ValueError):
            quickdraw_sample(record, "circle")
        record["drawing"] = [[[0, 1], [0, 1]]]
        with self.assertRaises(ValueError):
            quickdraw_sample(record, "square")


if __name__ == "__main__":
    unittest.main()
