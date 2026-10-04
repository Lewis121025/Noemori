"""弱标签诊断必须保留其语义，不能伪装成可信准确率或校准阈值。"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.training.diagnose import summarize_predictions
from modules.whiteboard.ink.training.review import reviewed_report


class DiagnosticsTests(unittest.TestCase):
    """同时检查分歧和其他类触发比例，避免把拒绝所有输入当成效果提升。"""

    def test_prompt_disagreements_and_coverage_have_distinct_denominators(self):
        rows = [
            {"source_label": "circle", "prompt_label": "circle", "prediction": "circle", "score": 0.96},
            {"source_label": "circle", "prompt_label": "circle", "prediction": "ellipse", "score": 0.99},
            {"source_label": "cat", "prompt_label": "other", "prediction": "other", "score": 0.97},
            {"source_label": "cat", "prompt_label": "other", "prediction": "line", "score": 0.80},
        ]
        result = summarize_predictions(rows)
        self.assertEqual(result["prompt_agreement"], 0.5)
        self.assertNotIn("accuracy", result)
        threshold = result["threshold_diagnostics"]["0.95"]
        self.assertEqual(threshold["candidate_fraction"], 0.5)
        self.assertEqual(threshold["prompt_disagreement_count"], 1)
        self.assertEqual(threshold["other_prompt_candidate_fraction"], 0)
        self.assertEqual(result["threshold_diagnostics"]["0.8"]["other_prompt_candidate_fraction"], 0.5)

    def test_empty_review_pool_is_not_a_perfect_score(self):
        with self.assertRaises(ValueError):
            summarize_predictions([])

    def test_review_excludes_ambiguity_from_agreement_but_tracks_its_triggers(self):
        decisions = [
            {"sample_id": "a", "source_sha256": "h", "reviewer": "codex_visual", "decision": "accept", "label": "circle"},
            {"sample_id": "b", "source_sha256": "i", "reviewer": "codex_visual", "decision": "ambiguous", "label": None},
        ]
        predictions = [
            {"sample_id": "a", "source_sha256": "h", "prediction": "circle", "score": 0.99},
            {"sample_id": "b", "source_sha256": "i", "prediction": "line", "score": 0.99},
        ]
        report = reviewed_report(decisions, predictions)
        self.assertEqual(report["agreement_with_ai_labels"], 1)
        self.assertEqual(report["accepted"], 1)
        self.assertEqual(report["unresolved"], 1)
        self.assertEqual(report["threshold_diagnostics"]["0.9"]["unresolved_candidate_count"], 1)
        predictions[0]["source_sha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "来源"):
            reviewed_report(decisions, predictions)


if __name__ == "__main__":
    unittest.main()
