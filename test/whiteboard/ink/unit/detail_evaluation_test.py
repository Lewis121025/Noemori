"""成对指标必须明确分母，不能只报告母图成功子集来掩盖整体失败。"""

import unittest

from modules.whiteboard.ink.training.evaluate_detail import summarize_detail


class DetailEvaluationTests(unittest.TestCase):
    """验证同母图关联与绝对/条件分类指标，缺失或改写真值立即失败。"""

    def test_conditional_stability_is_separate_from_all_samples_accuracy(self):
        rows, predictions = [], []
        for parent, label, clean_correct, noisy_correct in (("a", "circle", True, False), ("b", "ellipse", False, True)):
            for kind, correct in (("clean", clean_correct), ("jitter", noisy_correct)):
                identifier = parent + kind
                variant = {"kind": kind}
                if kind == "jitter":
                    variant["amplitude_relative_size"] = .015
                rows.append({"sample_id": identifier, "parent_id": parent, "label": label,
                             "provenance": {"variant": variant}})
                score = [0.] * 8
                index = (1 if label == "circle" else 2) if correct else 7
                score[index] = 1.
                predictions.append({"sample_id": identifier, "label": label,
                                    "prediction": label if correct else "other", "score": 1., "probabilities": score})
        result = summarize_detail(rows, predictions)["jitter/0.015"]
        self.assertEqual(result["accuracy"], .5)
        self.assertEqual(result["pairs_with_correct_clean"], 1)
        self.assertEqual(result["accuracy_given_correct_clean"], 0.)
        self.assertEqual(result["correct_at_0.5"], 1)
        with self.assertRaisesRegex(ValueError, "身份"):
            summarize_detail(rows, predictions[:-1])
        predictions[0]["label"] = "other"
        with self.assertRaisesRegex(ValueError, "真值"):
            summarize_detail(rows, predictions)
