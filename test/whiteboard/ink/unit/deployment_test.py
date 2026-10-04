"""导出必须检查数值而非仅检查文件存在，独立预处理必须与训练张量一致。"""

from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.training.benchmark import image_tensor
from modules.whiteboard.ink.training.data import image_transform
from modules.whiteboard.ink.training.export import check_outputs


class DeploymentTests(unittest.TestCase):
    """防止看似可加载但预测或归一化已经不同的模型进入部署。"""

    def test_matching_top1_does_not_hide_large_probability_drift(self):
        original = np.array([[1.0, 0.0]], dtype=np.float32)
        with self.assertRaisesRegex(ValueError, "一致性"):
            check_outputs(original, np.array([[10.0, 0.0]], dtype=np.float32))
        result = check_outputs(original, original + 1e-6)
        self.assertEqual(result["top1_mismatches"], 0)
        # softmax 对整体平移不变，不能用 logits 的绝对差代替分类一致性。
        self.assertEqual(check_outputs(original, original + 100)["top1_mismatches"], 0)

    def test_nonfinite_logits_are_rejected(self):
        with self.assertRaises(ValueError):
            check_outputs(np.array([[0.0, 1.0]]), np.array([[float("nan"), 1.0]]))

    def test_numpy_cpu_preprocessing_matches_training(self):
        rng = np.random.default_rng(4)
        image = Image.fromarray(rng.integers(0, 256, (224, 224, 3), dtype=np.uint8))
        mean, std = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "input.png"
            image.save(path)
            actual = image_tensor(path, {"mean": mean, "std": std})
        expected = image_transform(mean, std, False)(image).numpy()[None]
        np.testing.assert_allclose(actual, expected, atol=1e-7)
        self.assertEqual(actual.dtype, np.float32)
        self.assertTrue(actual.flags.c_contiguous)


if __name__ == "__main__":
    unittest.main()
