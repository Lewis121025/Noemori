"""分类评测方向、未知输入与图像预处理的训练契约。"""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import torch
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.training.data import ImageDataset, RetentionDataset, ShapeDataset, balanced_sampler, image_transform
from modules.whiteboard.ink.training.metrics import classification_report
from modules.whiteboard.ink.training.train import build_loaders


class TrainingContractTests(unittest.TestCase):
    """指标必须能暴露少数类别失败，输入必须保持静态图形的几何比例。"""

    def test_report_uses_true_rows_and_handles_unpredicted_class(self):
        result = classification_report([[8, 2, 0], [1, 3, 0], [0, 2, 0]], ("a", "b", "other"), 0.7)
        self.assertEqual(result["samples"], 16)
        self.assertAlmostEqual(result["accuracy"], 11 / 16)
        self.assertAlmostEqual(result["classes"]["a"]["precision"], 8 / 9)
        self.assertEqual(result["classes"]["other"]["support"], 2)
        self.assertEqual(result["classes"]["other"]["recall"], 0)
        self.assertAlmostEqual(result["macro_f1"], (16 / 19 + 6 / 11) / 3)

    def test_invalid_or_empty_evaluation_is_rejected(self):
        for matrix in ([[0]], [[-1]], [[True]], [[1, 2]], []):
            with self.assertRaises(ValueError):
                classification_report(matrix, ("a",), 0)
        with self.assertRaises(ValueError):
            classification_report([[1]], ("a",), float("nan"))

    def test_inference_transform_preserves_pixels_and_normalizes_channels(self):
        image = Image.new("RGB", (224, 224), "white")
        ImageDraw.Draw(image).rectangle((20, 90, 200, 130), outline="black", width=3)
        tensor = image_transform((0.5,) * 3, (0.5,) * 3, False)(image)
        self.assertEqual(tuple(tensor.shape), (3, 224, 224))
        self.assertTrue(torch.equal(tensor[0], tensor[1]))
        self.assertEqual(tensor[0, 90, 20].item(), -1)
        self.assertEqual(tensor[0, 0, 0].item(), 1)

    def test_review_and_empty_splits_cannot_enter_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "复核"):
                ShapeDataset(root, "review", None)
            (root / "train.jsonl").write_text("")
            with self.assertRaisesRegex(ValueError, "所有类别"):
                ShapeDataset(root, "train", None)

    def test_balanced_sampling_does_not_follow_a_dominant_negative_class(self):
        records = [(Path("unused"), 0)] * 100 + [(Path("unused"), 7)] * 900
        data = ImageDataset(records, None)
        sampled = list(balanced_sampler(data, 4))
        self.assertEqual(sampled, list(balanced_sampler(data, 4)))
        positives = sum(data.records[index][1] == 0 for index in sampled)
        self.assertGreater(positives, 430)
        self.assertLess(positives, 570)

    def test_training_rotations_keep_fixed_square_input_and_visible_ink(self):
        image = Image.new("RGB", (224, 224), "white")
        draw = ImageDraw.Draw(image)
        for x, y in ((16, 16), (208, 16), (208, 208), (16, 208)):
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill="black")
        transform = image_transform((0,) * 3, (1,) * 3, True)
        for seed in range(8):
            torch.manual_seed(seed)
            tensor = transform(image)
            self.assertEqual(tuple(tensor.shape), (3, 224, 224))
            self.assertGreater(int((tensor[0] < 0.5).sum()), 70)
            self.assertTrue(bool((tensor[:, 0, :] > 0.95).all()))
            self.assertTrue(bool((tensor[:, -1, :] > 0.95).all()))

    def test_sampling_preserves_small_negative_sources(self):
        records = [(Path("unused"), 0)] * 1000 + [(Path("unused"), 7)] * 1000
        sources = ["synthetic"] * 1000 + ["reviewed"] * 100 + ["letters"] * 900
        data = ImageDataset(records, None, sources)
        indices = list(balanced_sampler(data, 8))
        counts = {source: sum(data.sources[i] == source for i in indices) for source in set(sources)}
        self.assertGreater(counts["reviewed"], 400)
        self.assertLess(counts["reviewed"], 600)
        self.assertGreater(counts["letters"], 400)
        self.assertLess(counts["letters"], 600)

    def test_new_boundary_sources_are_not_retained_from_the_old_teacher(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "image.png"
            Image.new("RGB", (224, 224), "white").save(path)
            data = RetentionDataset([(path, 2)] * 3, image_transform((0,) * 3, (1,) * 3, False),
                                    ["synthetic_native", "synthetic_boundary_native", "quickdraw_boundary/ai_visual_review"])
            self.assertEqual([data[i][2] for i in range(3)], [True, False, False])

    def test_only_training_discards_tiny_tail_batch(self):
        class InMemoryImages(ImageDataset):
            def __getitem__(self, index):
                return torch.zeros(3, 4, 4), self.records[index][1]

        def dataset(directory, split, transform, extra):
            return InMemoryImages([(Path("unused"), i % 8) for i in range(19)], transform)

        with patch("modules.whiteboard.ink.training.train.ShapeDataset", side_effect=dataset):
            loaders = build_loaders(Path("unused"), (0,) * 3, (1,) * 3, 8, 0, 3, False)
        self.assertEqual([len(targets) for _, targets in loaders["train"]], [8, 8])
        for split in ("val", "test"):
            self.assertEqual(sum(len(targets) for _, targets in loaders[split]), 19)


if __name__ == "__main__":
    unittest.main()
