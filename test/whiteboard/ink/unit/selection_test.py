"""选模必须暴露来源及旧能力回退，不能靠负样本数量掩盖边界失败。"""

import copy
import unittest

from modules.whiteboard.ink.training.metrics import classification_report
from modules.whiteboard.ink.training.selection import canonical_source, selection_key, selection_report


def report(synthetic_correct, boundary_correct):
    sources = {}
    for name, correct, label in (("synthetic", synthetic_correct, 4), ("quickdraw_boundary/ai_visual_review", boundary_correct, 2)):
        matrix = [[0] * 8 for _ in range(8)]
        matrix[label][label] = correct
        matrix[label][7] = 100 - correct
        sources[name] = classification_report(matrix, ("line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow", "other"), .1)
    return {"sources": sources, "macro_f1": .99, "loss": .1}


class SelectionTests(unittest.TestCase):
    """同来源视图合并，候选必须同时守住旧验证契约。"""

    def test_original_and_native_are_same_evaluation_source(self):
        self.assertEqual(canonical_source("synthetic_native"), "synthetic")
        self.assertEqual(canonical_source("mmg"), "mmg")

    def test_larger_overall_score_cannot_hide_old_class_regression(self):
        reference = report(100, 30)
        stable = report(99, 70)
        regressed = report(90, 99)
        regressed["macro_f1"] = 1.
        self.assertGreater(selection_key(stable, reference), selection_key(regressed, reference))
        self.assertFalse(selection_report(regressed, reference)["passes_legacy_retention"])

    def test_new_boundary_improvement_is_selected_after_legacy_floor_passes(self):
        reference = report(100, 10)
        self.assertGreater(selection_key(report(99, 90), reference), selection_key(report(100, 30), reference))

    def test_missing_legacy_source_or_changed_support_is_rejected(self):
        reference = report(100, 50)
        changed = copy.deepcopy(reference)
        del changed["sources"]["synthetic"]
        with self.assertRaises(ValueError):
            selection_report(changed, reference)
        changed = copy.deepcopy(reference)
        changed["sources"]["synthetic"]["classes"]["rectangle"]["support"] += 1
        with self.assertRaises(ValueError):
            selection_report(changed, reference)
