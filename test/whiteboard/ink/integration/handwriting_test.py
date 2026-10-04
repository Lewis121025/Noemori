"""字符包原子发布、标签隔离和篡改拦截；仅替换归档I/O，不绕过记录验证。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.dataset.handwriting.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.handwriting.schema import ARCHIVES


def digits():
    for label, original_id, paths in (("8", 224, [[[0., 0.], [1., 2.], [2., 0.], [0., 1.]]]),
                                      ("0", 225, [[[0., 0.], [1., 1.], [2., 0.]]])):
        p = {"source": "pendigits", "cohort": "train", "local_writer_id": 12,
             "original_sample_id": original_id, "source_member": "pendigits-orig.tra.Z",
             "source_id": f"pendigits/train/writer-12/{original_id}", "source_sha256": "a" * 64,
             "archive_sha256": ARCHIVES["pendigits.zip"], "license": "CC-BY-4.0",
             "derivation": "original_unipen_screen_y_negated"}
        yield label, paths, p


class HandwritingPublicationTests(unittest.TestCase):
    """真实数据包只可发布完整版本；修改JSON并重算文件散列仍不能破坏标签契约。"""

    def test_publication_quarantines_zero_and_detects_label_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "proof.txt").write_text("fixture")
            evidence = {"proof.txt": file_record(root / "proof.txt")["sha256"]}
            output = root / "package"
            with patch("modules.whiteboard.ink.dataset.handwriting.package.EVIDENCE", evidence), \
                    patch("modules.whiteboard.ink.dataset.handwriting.package._verify_sources", return_value={}), \
                    patch("modules.whiteboard.ink.dataset.handwriting.package._digit_rows", side_effect=lambda _: digits()), \
                    patch("modules.whiteboard.ink.dataset.handwriting.package._letter_rows", return_value=[]), \
                    patch("modules.whiteboard.ink.dataset.handwriting.package._kanji_rows", return_value=[]):
                result = generate_dataset(root, root, output)
                self.assertEqual(result["counts"]["supervised"], 1)
                review = json.loads((output / "review.jsonl").read_text())
                self.assertIsNone(review["label"])
                self.assertEqual(review["source_label"], "0")
                self.assertEqual(validate_dataset(output), result["counts"])
                with self.assertRaisesRegex(ValueError, "覆盖"):
                    generate_dataset(root, root, output)
                split = next(s for s in ("train", "val") if (output / f"{s}.jsonl").stat().st_size)
                path = output / f"{split}.jsonl"
                row = json.loads(path.read_text())
                row["source_label"] = "1"
                path.write_text(json.dumps(row) + "\n")
                manifest = json.loads((output / "manifest.json").read_text())
                manifest["files"][path.name] = file_record(path)
                (output / "manifest.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "原语"):
                    validate_dataset(output)

    def test_failed_generation_cleans_partial_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "package"
            with patch("modules.whiteboard.ink.dataset.handwriting.package._verify_sources", return_value={}), \
                    patch("modules.whiteboard.ink.dataset.handwriting.package._digit_rows", side_effect=OSError("broken source")):
                with self.assertRaisesRegex(OSError, "broken source"):
                    generate_dataset(root, root, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.iterdir()), [])
