"""共享空间增强和成对参考来源的训练契约。"""

from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw
import torch

from modules.whiteboard.ink.training.contour import ContourDataset, ContourTransform


class ContourDataTests(unittest.TestCase):
    """粗尺度输入保留细线，母图/变体不能被不同随机变换错配。"""

    def test_identical_pair_has_identical_spatial_transform_and_visible_coarse_strokes(self):
        image = Image.new("RGB", (224, 224), "white")
        draw = ImageDraw.Draw(image)
        draw.line([(25, 110), (185, 110), (145, 75), (185, 110), (145, 145)], fill="black", width=3)
        transform = ContourTransform((0,) * 3, (1,) * 3)
        for seed in range(5):
            torch.manual_seed(seed)
            original, reference, coarse = transform(image, image)
            torch.testing.assert_close(original, reference, rtol=0, atol=0)
            self.assertEqual(tuple(coarse.shape), (3, 224, 224))
            self.assertGreater(int((coarse[0] < .5).sum()), 100)
            self.assertTrue(torch.isfinite(coarse).all())
            self.assertTrue((coarse[:, 0, :] > .95).all())

    def test_only_verified_reference_mapping_supplies_a_clean_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image, reference = root / "image.png", root / "clean.png"
            Image.new("RGB", (224, 224), "white").save(image)
            Image.new("RGB", (224, 224), "black").save(reference)
            data = ContourDataset([(image, 4)] * 2, (0,) * 3, (1,) * 3,
                                  ["synthetic_detail/synthetic_geometry", "synthetic_native"], {str(image): reference})
            row = data[0]
            self.assertFalse(row["retain"])
            self.assertTrue(data[1]["retain"])
            self.assertEqual(row["label"], 4)
            self.assertGreater(row["image"].mean().item(), .99)
            self.assertLess(row["reference"].mean().item(), .65)

    def test_noncanonical_parent_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image, reference = root / "image.png", root / "clean.png"
            Image.new("RGB", (224, 224), "white").save(image)
            Image.new("L", (224, 224), "white").save(reference)
            data = ContourDataset([(image, 4)], (0,) * 3, (1,) * 3, ["detail"], {str(image): reference})
            with self.assertRaisesRegex(ValueError, "RGB"):
                data[0]
