"""真实梯度证明三视图共享参数，并保持部署归一化统计。"""

import unittest

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from modules.whiteboard.ink.training.contour import contour_forward
from modules.whiteboard.ink.training.engine import run_epoch


class Views(Dataset):
    """八类固定输入携带同母图参考和训练专用粗图。"""

    def __len__(self):
        return 8

    def __getitem__(self, i):
        image = torch.eye(8)[i]
        return {"image": image, "reference": image * .9, "coarse": image * .7,
                "label": i, "retain": i < 2}


class SharedModel(nn.Module):
    """与生产骨干相同的特征/分类头接口，保持测试不依赖下载。"""

    def __init__(self):
        super().__init__()
        self.norm = nn.BatchNorm1d(8)
        self.embedding = nn.Linear(8, 12)
        self.classifier = nn.Linear(12, 8)

    def forward_features(self, images):
        return self.embedding(self.norm(images))

    def forward_head(self, features, pre_logits=False):
        return features if pre_logits else self.classifier(features)

    def get_classifier(self):
        return self.classifier


class ContourOptimizationTests(unittest.TestCase):
    """参考/粗图参与训练，不新增部署头，也不能用三图污染BN统计。"""

    def test_all_views_update_shared_weights_without_updating_batch_norm_statistics(self):
        torch.manual_seed(17)
        model, teacher = SharedModel(), nn.Linear(8, 8)
        before = model.embedding.weight.detach().clone()
        means, variances = model.norm.running_mean.clone(), model.norm.running_var.clone()
        optimizer = torch.optim.SGD(model.parameters(), lr=.05)
        result = run_epoch(model, DataLoader(Views(), batch_size=8), torch.device("cpu"), optimizer,
                           teacher=teacher, contour=True)
        self.assertEqual(result["samples"], 8)
        self.assertGreater(result["loss"], 0)
        self.assertFalse(torch.equal(before, model.embedding.weight))
        torch.testing.assert_close(means, model.norm.running_mean)
        torch.testing.assert_close(variances, model.norm.running_var)
        self.assertEqual(model.norm.num_batches_tracked.item(), 0)
        self.assertIsNotNone(model.norm.weight.grad)
        self.assertTrue(all(p.grad is None for p in teacher.parameters()))

    def test_malformed_or_nonfinite_shared_features_are_rejected(self):
        model = SharedModel().eval()
        images = torch.eye(8)
        with self.assertRaisesRegex(ValueError, "形状"):
            contour_forward(model, images, images[:2], images, torch.arange(8))
        with torch.no_grad():
            model.embedding.weight.fill_(float("nan"))
        with self.assertRaisesRegex(ValueError, "特征"):
            contour_forward(model, images, images, images, torch.arange(8))

    def test_three_view_training_is_not_an_evaluation_or_deployment_interface(self):
        with self.assertRaises(ValueError):
            run_epoch(SharedModel(), DataLoader(Views(), batch_size=8), torch.device("cpu"), contour=True)

    def test_zero_weight_ablation_has_only_original_classification_loss(self):
        torch.manual_seed(13)
        model = SharedModel().eval()
        images = torch.eye(8)
        labels = torch.arange(8)
        with torch.no_grad():
            logits, _ = contour_forward(model, images, images * .9, images * .7, labels)
            expected = nn.functional.cross_entropy(logits, labels).item()
        result = run_epoch(model, DataLoader(Views(), batch_size=8), torch.device("cpu"),
                           torch.optim.SGD(model.parameters(), lr=0), contour=True, contour_weight=0)
        self.assertAlmostEqual(result["loss"], expected, places=6)
