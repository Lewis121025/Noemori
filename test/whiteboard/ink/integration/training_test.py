"""训练执行器的参数更新、独立评测与权重发布验证；不下载预训练模型。"""

from pathlib import Path
import copy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.training.engine import reestimate_batch_norm, run_epoch, save_checkpoint
from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.train import finalize
from modules.whiteboard.ink.training.train import fit
from modules.whiteboard.ink.training.adapter import enable_adapter


class FixedFeatureClassifier(nn.Module):
    """可解析的固定特征分类器，验证两头训练的真实选模和基线数据流。"""

    def __init__(self):
        super().__init__()
        self.classifier = nn.Linear(8, 8, bias=False)
        with torch.no_grad():
            self.classifier.weight.copy_(torch.eye(8) * 5)

    def get_classifier(self):
        return self.classifier

    def forward_features(self, inputs):
        return inputs

    def forward_head(self, features, pre_logits=False):
        return features if pre_logits else self.classifier(features)

    def forward(self, inputs):
        return self.classifier(inputs)


class TrainingExecutionTests(unittest.TestCase):
    """用可解析的小网络验证真实优化与统计，不靠完整训练曲线掩盖执行错误。"""

    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(9)

    def test_evaluation_weights_partial_batch_and_does_not_update_parameters(self):
        inputs = torch.eye(8)
        targets = torch.arange(8)
        model = nn.Linear(8, 8, bias=False)
        with torch.no_grad():
            model.weight.copy_(torch.eye(8) * 3)
        initial = model.weight.detach().clone()
        loader = DataLoader(TensorDataset(inputs, targets), batch_size=3)
        result = run_epoch(model, loader, torch.device("cpu"))
        expected = nn.functional.cross_entropy(inputs * 3, targets).item()
        self.assertAlmostEqual(result["loss"], expected, places=6)
        self.assertEqual(result["accuracy"], 1)
        self.assertEqual(result["macro_f1"], 1)
        self.assertEqual(result["samples"], 8)
        self.assertTrue(torch.equal(initial, model.weight))
        self.assertIsNone(model.weight.grad)

    def test_training_changes_weights_and_reduces_loss(self):
        inputs, targets = torch.eye(8), torch.arange(8)
        loader = DataLoader(TensorDataset(inputs, targets), batch_size=8)
        model = nn.Linear(8, 8)
        optimizer = torch.optim.SGD(model.parameters(), lr=1)
        initial = model.weight.detach().clone()
        before = run_epoch(model, loader, torch.device("cpu"))
        for _ in range(8):
            run_epoch(model, loader, torch.device("cpu"), optimizer)
        after = run_epoch(model, loader, torch.device("cpu"))
        self.assertLess(after["loss"], before["loss"])
        self.assertFalse(torch.equal(initial, model.weight))

    def test_product_retention_uses_single_head_teacher_even_when_zero_adapter_is_unsafe(self):
        teacher = FixedFeatureClassifier().eval()
        model = copy.deepcopy(teacher)
        enable_adapter(model)
        inputs, labels = torch.eye(8), torch.arange(8)
        validation = TensorDataset(inputs, labels)
        validation.sources = ["fixture"] * 8
        val = DataLoader(validation, batch_size=4)
        train = DataLoader(TensorDataset(inputs, labels, torch.ones(8, dtype=torch.bool)), batch_size=4)
        reference = run_epoch(teacher, val, torch.device("cpu"), report_sources=True)
        baseline = {"correct": 8, "passes_product_retention": True}
        unsafe = {"correct": 7, "passes_product_retention": False}
        metadata = {"classifier_head": "residual_64", "selection_protocol": "source_family_with_class_retention",
                    "retention": {"reference_validation": reference}, "preprocessing": {},
                    "static_images": {"excluded_originals": [], "excluded_pixel_conflicts": []},
                    "evaluation_scope": "fixture"}
        validation.records = [(Path(f"fixture-{i}"), i) for i in range(8)]
        with tempfile.TemporaryDirectory() as temporary:
            args = SimpleNamespace(output=Path(temporary), learning_rate=.001, epochs=1, patience=1,
                                   product_validation=Path("unused-product-fixture"))
            with patch("modules.whiteboard.ink.training.product_validation.ProductValidation") as product:
                product.return_value.metadata = {"scope": "fixture"}
                product.return_value.evaluate.side_effect = [baseline, unsafe, unsafe]
                fit(model, {"train": train, "val": val, "test": val}, torch.device("cpu"), args, metadata, teacher)
            calls = product.return_value.evaluate.call_args_list
            self.assertIs(calls[0].args[0], teacher)
            self.assertIs(calls[1].args[0], model)
            self.assertIs(calls[1].args[2], baseline)
            self.assertIs(calls[2].args[2], baseline)
            saved = torch.load(args.output / "best.pt", weights_only=True)
            self.assertFalse(saved["product_validation"]["passes_product_retention"])
            self.assertEqual(saved["metadata"]["product_reference"], baseline)

    @unittest.skipUnless(torch.cuda.is_available(), "需要 CUDA 比较部署精度与混合精度")
    def test_gpu_evaluation_matches_fp32_deployment_for_sensitive_logits(self):
        class SensitiveClassifier(nn.Module):
            def __init__(self):
                super().__init__()
                self.linear = nn.Linear(1, 8, bias=False)
                with torch.no_grad():
                    self.linear.weight.zero_()
                    self.linear.weight[0, 0] = 1000
                self.register_buffer("offset", torch.tensor([1000.5, 0, 10, 10, 10, 10, 10, 10]))

            def forward(self, inputs):
                return self.linear(inputs).float() - self.offset

        model = SensitiveClassifier().cuda()
        inputs, targets = torch.tensor([[1.001], [1.002]]), torch.zeros(2, dtype=torch.long)
        loader = DataLoader(TensorDataset(inputs, targets), batch_size=2)
        with torch.inference_mode():
            expected = nn.functional.cross_entropy(model(inputs.cuda()), targets.cuda()).item()
        result = run_epoch(model, loader, torch.device("cuda"))
        self.assertAlmostEqual(result["loss"], expected, places=5)
        self.assertEqual(result["accuracy"], 1)

    def test_failed_checkpoint_write_preserves_previous_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "best.pt"
            save_checkpoint(path, {"epoch": 1})
            original = path.read_bytes()
            with patch("modules.whiteboard.ink.training.engine.torch.save", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    save_checkpoint(path, {"epoch": 2})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(temporary).iterdir()), [path])
            self.assertEqual(torch.load(path, weights_only=True), {"epoch": 1})

    def test_bn_reestimation_updates_only_statistics_and_keeps_dropout_disabled(self):
        model = nn.Sequential(nn.BatchNorm1d(2), nn.Dropout(0.8), nn.Linear(2, 8))
        initial = [parameter.detach().clone() for parameter in model.parameters()]
        loader = DataLoader(TensorDataset(torch.full((8, 2), 10.0), torch.zeros(8, dtype=torch.long)), batch_size=4)
        result = reestimate_batch_norm(model, loader, torch.device("cpu"))
        self.assertEqual(result["samples"], 8)
        self.assertEqual(result["parameter_updates"], 0)
        torch.testing.assert_close(model[0].running_mean, torch.tensor([10.0, 10.0]))
        self.assertEqual(model[0].num_batches_tracked.item(), 2)
        self.assertEqual(model[0].momentum, 0.1)
        self.assertFalse(model.training)
        self.assertFalse(model[1].training)
        for before, after in zip(initial, model.parameters()):
            self.assertTrue(torch.equal(before, after))

    def test_rejected_statistics_are_restored_before_touching_test_data(self):
        model = nn.Sequential(nn.BatchNorm1d(2), nn.Linear(2, 8))
        records = [(Path("unused"), i) for i in range(8)]
        train = SimpleNamespace(dataset=ImageDataset(records, None))
        val, test = object(), object()
        metadata = {"preprocessing": {"mean": [0.5] * 3, "std": [0.5] * 3},
                    "evaluation_scope": "synthetic_only", "gesture_dataset": None}
        before = {"macro_f1": 0.9, "loss": 0.1}

        def changed_statistics(model, loader, device):
            model[0].running_mean.fill_(10)
            return {"samples": 8}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            save_checkpoint(root / "best.pt", {"model": model.state_dict(), "validation": before})
            args = SimpleNamespace(output=root, batch_size=4, seed=3)
            with patch("modules.whiteboard.ink.training.train.reestimate_batch_norm", side_effect=changed_statistics), \
                    patch("modules.whiteboard.ink.training.train.run_epoch", side_effect=[{"macro_f1": 0.8, "loss": 0.2}, {"accuracy": 0.7}]) as evaluate:
                result = finalize(model, {"train": train, "val": val, "test": test}, torch.device("cpu"), args, metadata, 1, 2)
            self.assertEqual(result["validation"], before)
            self.assertFalse(metadata["normalization_selection"]["selected_reestimation"])
            self.assertEqual([call.args[1] for call in evaluate.call_args_list], [val, test])
            self.assertTrue(torch.equal(model[0].running_mean, torch.zeros(2)))


if __name__ == "__main__":
    unittest.main()
