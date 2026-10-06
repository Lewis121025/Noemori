"""静态派生视图必须复用已验证真值，禁止借缓存换标签或把保留像素加入训练。"""

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.native_images import pixel_hash
from modules.whiteboard.ink.training.static_images import append_static_views


class StaticViewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.datasets, self.accepted, self.rows = {}, {}, []
        for i, split in enumerate(("train", "val", "test")):
            original, derived = self.root/f"{split}.png", self.cache/f"{split}.png"
            image = Image.new("RGB", (224, 224), (255, 255, 255))
            image.putpixel((i+1, i+1), (0, 0, 0))
            image.save(original)
            image.putpixel((50+i, 50+i), (0, 0, 0))
            image.save(derived)
            self.datasets[split] = ImageDataset([(original, 1)], None, ["verified"])
            self.accepted[str(original.resolve())] = (split, 1, "verified")
            self.rows.append({"sample_id": split, "original": str(original), "split": split, "label": 1,
                              "image": derived.name, "original_sha256": file_record(original)["sha256"],
                              "image_sha256": file_record(derived)["sha256"], "pixel_sha256": pixel_hash(derived)})
        self.publish()

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self):
        records = self.cache/"records.jsonl"
        records.write_text("".join(json.dumps(row)+"\n" for row in self.rows))
        (self.cache/"manifest.json").write_text(json.dumps({"dataset": "product-static-images-v1",
            "files": {"records.jsonl": file_record(records)}, "pipeline": {}, "source_files": {}}))

    def test_view_additions_preserve_originals_and_split_labels(self):
        datasets, metadata = append_static_views(self.datasets, self.cache, self.accepted)
        self.assertEqual(metadata["added_views"], {"train": 1, "val": 1, "test": 1})
        for split, data in datasets.items():
            self.assertEqual(data.records[0], self.datasets[split].records[0])
            self.assertEqual(data.records[1][1], 1)
            self.assertEqual(len(self.datasets[split]), 1)

    def test_rehashed_supervision_drift_is_rejected(self):
        self.rows[0]["label"] = 2
        self.publish()
        with self.assertRaisesRegex(ValueError, "来源身份"):
            append_static_views(self.datasets, self.cache, self.accepted)

    def test_new_training_view_equal_to_a_holdout_pixel_is_quarantined(self):
        image = self.cache/"train.png"
        image.write_bytes(self.datasets["test"].records[0][0].read_bytes())
        self.rows[0].update(image_sha256=file_record(image)["sha256"], pixel_sha256=pixel_hash(image))
        self.publish()
        datasets, metadata = append_static_views(self.datasets, self.cache, self.accepted)
        self.assertEqual(metadata["excluded_pixel_conflicts"], ["train"])
        self.assertEqual(len(datasets["train"]), 1)

    def test_image_bytes_cannot_drift_under_an_unchanged_manifest(self):
        (self.cache/"train.png").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "产品图像"):
            append_static_views(self.datasets, self.cache, self.accepted)

    def test_previously_isolated_original_cannot_return_with_different_pixels(self):
        origin = self.rows[0]["original"]
        datasets, metadata = append_static_views(self.datasets, self.cache, self.accepted, {origin})
        self.assertNotEqual(self.rows[0]["pixel_sha256"], pixel_hash(self.datasets["train"].records[0][0]))
        self.assertEqual(metadata["excluded_originals"], ["train"])
        self.assertEqual(len(datasets["train"]), 1)
        self.assertEqual(metadata["added_views"], {"val": 1, "test": 1})
