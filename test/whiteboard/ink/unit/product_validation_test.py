"""最终几何子类型与逐样本回退必须独立于分类平均分验收。"""

import json
from pathlib import Path
import tempfile
import unittest

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.training.product_validation import ProductValidation, product_report


def sample(identity, truth, label):
    return {"sample_id": identity, "source": "fixture", "truth": truth, "label": label}


class ProductValidationTests(unittest.TestCase):
    """一个新修复不能抵消另一个旧正确样本丢失，也不能抵消负例误吸附。"""

    def test_new_success_cannot_offset_loss_of_old_success(self):
        reference = product_report([sample("a", "ellipse", "ellipse"), sample("b", "ellipse", None)])
        result = product_report([sample("a", "ellipse", "circle"), sample("b", "ellipse", "ellipse")], reference)
        self.assertEqual(result["correct"], reference["correct"])
        self.assertFalse(result["passes_product_retention"])
        self.assertEqual(result["lost_correct"], ["a"])
        self.assertEqual(result["new_wrong"], ["a"])

    def test_wrong_final_subtype_and_negative_are_not_successes(self):
        result = product_report([sample("a", "circle", "ellipse"), sample("b", "other", "line")])
        self.assertEqual(result["correct"], 0)
        self.assertEqual(result["wrong"], 2)

    def test_other_accepted_is_a_new_regression(self):
        reference = product_report([sample("a", "other", None)])
        result = product_report([sample("a", "other", "triangle")], reference)
        self.assertFalse(result["passes_product_retention"])

    def test_new_correct_repair_preserves_reference(self):
        reference = product_report([sample("a", "circle", "circle"), sample("b", "ellipse", None)])
        result = product_report([sample("a", "circle", "circle"), sample("b", "ellipse", "ellipse")], reference)
        self.assertTrue(result["passes_product_retention"])
        self.assertEqual(result["correct"], 2)

    def test_missing_duplicate_or_changed_truth_is_rejected(self):
        rows = [sample("a", "circle", "circle"), sample("b", "ellipse", None)]
        reference = product_report(rows)
        for invalid in [rows[:1], rows + rows[:1], [sample("a", "ellipse", None), rows[1]]]:
            with self.assertRaises(ValueError):
                product_report(invalid, reference)

    def test_source_isolated_views_cannot_enter_product_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            samples = []
            origins = []
            for i in range(2):
                image = root / f"{i}.png"
                image.write_bytes(bytes([i]))
                points = [[[0, 0], [100, 0]]]
                origins.append({"sample_id": str(i), "label": "line", "paths": points})
                samples.append({"sample_id": str(i), "origin_id": str(i), "source": "fixture",
                                "source_directory": str(root), "label": "line", "paths": points,
                                "image": str(image), "image_sha256": file_record(image)["sha256"],
                                "snapshot_sha256": str(i)})
            (root / "val.jsonl").write_text("".join(json.dumps(row) + "\n" for row in origins))
            records = root / "samples.jsonl"
            records.write_text("".join(json.dumps(row) + "\n" for row in samples))
            (root / "manifest.json").write_text(json.dumps({"dataset": "product-validation-v1", "split": "val",
                                                          "dependencies": {}, "samples": file_record(records)}))
            before = set(root.iterdir())
            validator = ProductValidation(root, {}, {str(root / "0.png"), str(root / "1.png")}, {"1"})
            self.assertEqual([row["sample_id"] for row in validator.samples], ["0"])
            self.assertEqual(validator.metadata["isolated_samples"], ["1"])
            self.assertEqual(before, set(root.iterdir()))
            with self.assertRaisesRegex(ValueError, "不能为空"):
                ProductValidation(root, {}, set(), set())
