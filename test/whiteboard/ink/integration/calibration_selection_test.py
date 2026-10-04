"""归一化统计必须遵守来源/回退排序，不能只按总体F1覆盖候选。"""

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch
from torch import nn

from modules.whiteboard.ink.dataset.classification.schema import LABELS
from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.metrics import classification_report
from modules.whiteboard.ink.training.train import calibrated_validation


def score(correct, macro):
    matrix = [[0] * 8 for _ in LABELS]
    matrix[4][4], matrix[4][7] = correct, 100 - correct
    return {"macro_f1": macro, "loss": .1, "sources": {"synthetic": classification_report(matrix, LABELS, .1)}}


class CalibrationSelectionTests(unittest.TestCase):
    """可重放的缓冲区变化证明验收选择，而不是仅检查日志字段。"""

    def test_statistics_with_retained_legacy_recall_win_over_higher_pooled_f1(self):
        model = nn.Sequential(nn.BatchNorm1d(2), nn.Linear(2, 8))
        train = SimpleNamespace(dataset=ImageDataset([(Path("unused"), 4)], None))
        metadata = {"preprocessing": {"mean": [.5] * 3, "std": [.5] * 3},
                    "retention": {"reference_validation": score(100, .9)}}
        args = SimpleNamespace(batch_size=1, workers=0, seed=1)
        def change(model, loader, device):
            model[0].running_mean.fill_(7)
            return {"samples": 1}
        after, before = score(100, .9), score(90, .99)
        with patch("modules.whiteboard.ink.training.train.reestimate_batch_norm", side_effect=change), \
                patch("modules.whiteboard.ink.training.train.run_epoch", side_effect=[after, before]):
            selected, details = calibrated_validation(model, {"train": train, "val": object()}, torch.device("cpu"), args, metadata)
        self.assertEqual(selected, after)
        self.assertTrue(details["selected_reestimation"])
        torch.testing.assert_close(model[0].running_mean, torch.full((2,), 7.))
