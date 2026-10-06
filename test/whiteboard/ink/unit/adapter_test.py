"""零初始化、固定骨干与训练后的分类头可恢复性验证。"""

import copy
import unittest

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from modules.whiteboard.ink.training.adapter import ClassifierAdapter, DeploymentHeads, enable_adapter, verify_original
from modules.whiteboard.ink.training.engine import run_epoch


class TinyClassifier(nn.Module):
    """带统计和Dropout的小型特征提取器，用于检查固定特征的真实状态。"""

    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(nn.BatchNorm1d(8), nn.Dropout(.5))
        self.classifier = nn.Linear(8, 8)

    def get_classifier(self):
        return self.classifier

    def forward(self, values):
        return self.classifier(self.features(values))

    def forward_features(self, values):
        return self.features(values)

    def forward_head(self, features, pre_logits=False):
        return features if pre_logits else self.classifier(features)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(2)
        torch.set_num_threads(2)

    def test_initial_logits_are_exactly_identical_and_only_residual_is_trainable(self):
        model = TinyClassifier().eval()
        inputs = torch.eye(8)
        before = model(inputs).detach()
        enable_adapter(model)
        self.assertTrue(torch.equal(before, model(inputs)))
        self.assertTrue(all(not p.requires_grad for p in model.features.parameters()))
        self.assertTrue(all(not p.requires_grad for p in model.classifier.base.parameters()))
        self.assertTrue(all(p.requires_grad for p in model.classifier.refine.parameters()))

    def test_training_changes_residual_but_preserves_original_parameters_and_statistics(self):
        model = TinyClassifier().eval()
        enable_adapter(model)
        initial = copy.deepcopy(model.state_dict())
        loader = DataLoader(TensorDataset(torch.eye(8), torch.arange(8)), batch_size=8)
        optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=.05)
        before = run_epoch(model, loader, torch.device("cpu"))
        for _ in range(5):
            run_epoch(model, loader, torch.device("cpu"), optimizer, fixed_features=True)
        after = run_epoch(model, loader, torch.device("cpu"))
        self.assertLess(after["loss"], before["loss"])
        for name, value in model.state_dict().items():
            if not name.startswith("classifier.refine."):
                self.assertTrue(torch.equal(initial[name], value), name)
        restored = TinyClassifier()
        enable_adapter(restored)
        restored.load_state_dict(model.state_dict(), strict=True)
        self.assertTrue(torch.equal(model.eval()(torch.eye(8)), restored.eval()(torch.eye(8))))

    def test_wrong_class_count_is_rejected(self):
        with self.assertRaises(ValueError):
            ClassifierAdapter(nn.Linear(8, 7))

    def test_deployment_original_report_is_not_replaced_by_refinement_accuracy(self):
        model = TinyClassifier().eval()
        loader = DataLoader(TensorDataset(torch.eye(8), torch.arange(8)), batch_size=3)
        original = run_epoch(model, loader, torch.device("cpu"))
        enable_adapter(model)
        with torch.no_grad():
            model.classifier.refine[-1].bias[2] = 20
        deployed = run_epoch(model, loader, torch.device("cpu"), original_head=True)
        refined = run_epoch(model, loader, torch.device("cpu"))
        self.assertEqual(deployed["confusion"], original["confusion"])
        self.assertAlmostEqual(deployed["loss"], original["loss"], places=6)
        self.assertNotEqual(refined["confusion"], deployed["confusion"])
        optimizer = torch.optim.Adam(model.classifier.refine.parameters())
        with self.assertRaisesRegex(ValueError, "不能作为训练输出"):
            run_epoch(model, loader, torch.device("cpu"), optimizer, original_head=True)

    def test_two_outputs_keep_original_logits_exact_after_residual_changes(self):
        original = TinyClassifier().eval()
        model = copy.deepcopy(original)
        enable_adapter(model)
        with torch.no_grad():
            model.classifier.refine[-1].bias[2] = 4
        features = model.features(torch.eye(8))
        primary, refined = DeploymentHeads(model.classifier)(features)
        self.assertTrue(torch.equal(primary, original(torch.eye(8))))
        self.assertTrue(torch.equal(refined, model(torch.eye(8))))
        self.assertFalse(torch.equal(primary, refined))
        verify_original(model, original)
        with torch.no_grad():
            model.features[0].running_mean[0] = 1
        with self.assertRaisesRegex(ValueError, "漂移"):
            verify_original(model, original)

    def test_dual_teacher_preserves_its_deployment_head_while_checking_original_tensors(self):
        teacher = TinyClassifier().eval()
        enable_adapter(teacher)
        with torch.no_grad():
            teacher.classifier.refine[-1].bias[2] = 4
        model = copy.deepcopy(teacher)
        with torch.no_grad():
            model.classifier.refine[-1].bias[2] = 5
        before = copy.deepcopy(teacher.state_dict())
        verify_original(model, teacher)
        for name, value in teacher.state_dict().items():
            self.assertTrue(torch.equal(before[name], value))
        with torch.no_grad():
            model.classifier.base.weight[0, 0] += 1
        with self.assertRaisesRegex(ValueError, "漂移"):
            verify_original(model, teacher)
