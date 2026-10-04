"""真实优化验证旧模型只约束旧来源，顺序来源报告和部署标签一致。"""

import unittest

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from modules.whiteboard.ink.training.engine import run_epoch, retention_loss


class SourcedTensors(TensorDataset):
    """顺序索引携带真实来源，测试不依赖磁盘图像或网络下载。"""

    def __init__(self, inputs, labels, sources):
        super().__init__(inputs, labels)
        self.sources = sources


class RetentionTests(unittest.TestCase):
    """教师预测不能改写真值，也不能让新增复核样本学习旧错误。"""

    def test_source_reports_match_rows_and_merge_native_views(self):
        model = nn.Linear(8, 8, bias=False)
        with torch.no_grad():
            model.weight.copy_(torch.eye(8) * 5)
        data = SourcedTensors(torch.eye(8)[:4], torch.arange(4), ["synthetic", "synthetic_native", "boundary", "boundary"])
        result = run_epoch(model, DataLoader(data, batch_size=3), torch.device("cpu"), report_sources=True)
        self.assertEqual(result["sources"]["synthetic"]["samples"], 2)
        self.assertEqual(result["sources"]["boundary"]["classes"]["ellipse"]["support"], 1)
        self.assertEqual(result["accuracy"], 1.)
        with self.assertRaisesRegex(ValueError, "顺序"):
            run_epoch(model, DataLoader(data, batch_size=2, shuffle=True), torch.device("cpu"), report_sources=True)

    def test_teacher_sees_only_explicitly_retained_rows_and_has_no_gradient(self):
        class RecordingTeacher(nn.Linear):
            def __init__(self):
                super().__init__(8, 8)
                self.seen = []

            def forward(self, inputs):
                self.seen.append(inputs.detach().clone())
                return super().forward(inputs)

        inputs, labels, mask = torch.eye(8)[:3], torch.arange(3), torch.tensor([True, False, True])
        student, teacher = nn.Linear(8, 8), RecordingTeacher()
        loader = DataLoader(TensorDataset(inputs, labels, mask), batch_size=3)
        optimizer = torch.optim.SGD(student.parameters(), lr=.1)
        run_epoch(student, loader, torch.device("cpu"), optimizer, teacher=teacher)
        self.assertEqual(len(teacher.seen), 1)
        torch.testing.assert_close(teacher.seen[0], inputs[[0, 2]])
        self.assertTrue(all(parameter.grad is None for parameter in teacher.parameters()))
        self.assertFalse(teacher.training)

    def test_no_retained_rows_never_call_the_teacher(self):
        class ForbiddenTeacher(nn.Module):
            def forward(self, inputs):
                raise AssertionError("新增数据不能请求教师输出")

        student = nn.Linear(8, 8)
        loader = DataLoader(TensorDataset(torch.eye(8)[:2], torch.arange(2), torch.zeros(2, dtype=torch.bool)), batch_size=2)
        run_epoch(student, loader, torch.device("cpu"), torch.optim.SGD(student.parameters(), lr=.1), teacher=ForbiddenTeacher())

    def test_identical_logits_have_zero_distillation_cost(self):
        logits = torch.arange(16, dtype=torch.float32).reshape(2, 8)
        self.assertAlmostEqual(retention_loss(logits, logits).item(), 0., places=6)
