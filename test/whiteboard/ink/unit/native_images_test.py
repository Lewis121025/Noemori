"""端侧渲染视图只能保留已验证原始记录的身份、标签和划分。"""

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.native_images import load_native_images


class NativeImageContractTests(unittest.TestCase):
    """额外像素表示不能绕过监督来源或把 review 样本悄悄升级。"""

    def package(self, folder: Path, source: Path, **changes):
        """构造最小包，所有散列跟随测试故意修改的内容。"""
        Image.new("RGB", (224, 224), "white").save(folder / "native.png")
        row = {"original": str(source), "original_sha256": file_record(source)["sha256"],
               "split": "train", "label": "line", "sample_id": "a", "group_id": "g",
               "image": "native.png", "image_sha256": file_record(folder / "native.png")["sha256"]}
        row.update(changes)
        (folder / "records.jsonl").write_text(json.dumps(row) + "\n")
        (folder / "manifest.json").write_text(json.dumps({"schema_version": 1,
            "records": file_record(folder / "records.jsonl")}))

    def test_view_changes_only_image_path_and_keeps_label(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); source = folder / "source.png"
            Image.new("RGB", (224, 224), "white").save(source)
            self.package(folder, source)
            data = ImageDataset([(source, 0)], None, ["synthetic"])
            rows, metadata = load_native_images(folder, {"train": data})
            self.assertEqual(rows["train"], [(folder / "native.png", 0)])
            self.assertEqual(metadata["directory"], str(folder))

    def test_missing_relabelled_repartitioned_or_tampered_view_is_rejected(self):
        for changes in ({"label": "circle"}, {"split": "test"}, {"split": "review"},
                        {"original_sha256": "0" * 64}, {"image_sha256": "0" * 64},
                        {"original": "/missing.png"}, {"image": "../outside.png"}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp); source = folder / "source.png"
                Image.new("RGB", (224, 224), "white").save(source)
                self.package(folder, source, **changes)
                data = ImageDataset([(source, 0)], None, ["synthetic"])
                with self.assertRaises(ValueError):
                    load_native_images(folder, {"train": data})

    def test_review_view_requires_already_verified_negative_overlay(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); source = folder / "source.png"
            Image.new("RGB", (224, 224), "white").save(source)
            self.package(folder, source, split="review", label="other")
            data = ImageDataset([(source, 7)], None, ["ai_reviewed_quickdraw"])
            rows, _ = load_native_images(folder, {"train": data})
            self.assertEqual(rows["train"][0][1], 7)
