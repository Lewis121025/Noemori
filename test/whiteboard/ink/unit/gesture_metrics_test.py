"""真实手势评测分别衡量正例覆盖和负例误触发，避免类别不均衡造成虚高。"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.schema import LABELS
from modules.whiteboard.ink.training.evaluate_gestures import summarize_gestures


class GestureMetricsTests(unittest.TestCase):
    """协议标签和模型概率的样本总量必须一致。"""

    def test_positive_coverage_and_negative_false_trigger_have_separate_denominators(self):
        rows = []
        for label, prediction, score in (("arrow", "arrow", 0.99), ("arrow", "other", 0.99),
                                         ("other", "arrow", 0.95), ("other", "other", 0.99)):
            probabilities = [(1 - score) / 7] * 8
            probabilities[LABELS.index(prediction)] = score
            rows.append({"label": label, "prediction": prediction, "score": score,
                         "source_label": label, "probabilities": probabilities})
        report = summarize_gestures(rows)
        self.assertEqual(report["accuracy"], 0.5)
        self.assertEqual(report["balanced_accuracy_present_classes"], 0.5)
        at = report["threshold_diagnostics"]["0.9"]
        self.assertEqual(at["correct_positive_coverage"], 0.5)
        self.assertEqual(at["negative_candidate_fraction"], 0.5)
        self.assertEqual(at["correct_candidate_fraction"], 0.5)

    def test_empty_input_is_rejected(self):
        with self.assertRaises(ValueError):
            summarize_gestures([])


if __name__ == "__main__":
    unittest.main()
