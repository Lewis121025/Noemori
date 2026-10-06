"""外部真实数据入口必须隔离review、原始组和跨来源像素重复。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.external import load_external_packages, merge_external
from modules.whiteboard.ink.training.native_images import pixel_hash
from modules.whiteboard.ink.training.train import build_loaders
from modules.whiteboard.ink.dataset.classification.schema import LABELS


class ExternalDataTests(unittest.TestCase):
    """候选标签不可进入监督，完全相同输入不可跨训练和评测边界。"""

    def test_unknown_or_candidate_package_cannot_supply_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "manifest.json").write_text(json.dumps({"dataset": "quickdraw-real-shape-candidates-v2"}))
            with self.assertRaisesRegex(ValueError, "拒绝"):
                load_external_packages([root])
            with self.assertRaisesRegex(ValueError, "重复"):
                load_external_packages([root, root])

    def test_same_quickdraw_key_cannot_leak_between_different_package_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directories = []
            for index, (version, split) in enumerate((("quickdraw-real-shapes-v1", "train"), ("shape-boundary-review-v1", "val"))):
                directory = Path(temporary) / str(index)
                directory.mkdir(); directories.append(directory)
                (directory / "manifest.json").write_text(json.dumps({"dataset": version, "classes": list(LABELS), "counts": {}}))
                for partition in ("train", "val", "test"):
                    row = {"split": split, "label": "ellipse", "annotation_status": "accepted", "sample_id": str(index),
                           "group_id": "quickdraw-key-123", "image": "unused.png", "annotation_kind": "ai_visual_review",
                           "pixel_sha256": str(index), "provenance": {}}
                    (directory / f"{partition}.jsonl").write_text(json.dumps(row) + "\n" if partition == split else "")
            with patch("modules.whiteboard.ink.training.external._validate"):
                with self.assertRaisesRegex(ValueError, "跨划分"):
                    load_external_packages(directories)

    def test_cross_source_duplicate_is_removed_from_both_splits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for index in range(4):
                image = Image.new("RGB", (224, 224), "white")
                ImageDraw.Draw(image).line((20, 20 + 10 * index, 200, 200), fill="black", width=3)
                path = root / f"{index}.png"
                image.save(path)
                paths.append(path)
            duplicate = root / "duplicate.png"
            duplicate.write_bytes(paths[0].read_bytes())
            datasets = {split: ImageDataset([(path, 7)], None, ["old"])
                        for split, path in zip(("train", "val", "test"), paths[:3])}
            external = {"records": {"train": [(paths[3], 7)], "val": [], "test": [(duplicate, 7)]},
                        "sources": {"train": ["new"], "val": [], "test": ["new"]},
                        "pixels": {str(path): pixel_hash(path) for path in (paths[3], duplicate)}}
            result, details = merge_external(datasets, external)
            self.assertEqual(details["cross_split_pixel_groups"], 1)
            self.assertEqual({item["path"] for item in details["removed"]}, {str(paths[0]), str(duplicate)})
            self.assertEqual(result["train"].records, [(paths[3], 7)])
            self.assertEqual(result["test"].records, [(paths[2], 7)])

    def test_external_records_are_appended_after_native_mapping(self):
        original = ImageDataset([(Path("original"), label) for label in range(8)], None)
        new = [(Path("external"), 7)]
        external = {"records": {split: new for split in ("train", "val", "test")},
                    "sources": {split: ["new"] for split in ("train", "val", "test")}, "pixels": {}}
        def merge(datasets, extra, reserved):
            for data in datasets.values():
                self.assertNotIn(new[0], data.records)
            return {split: ImageDataset(data.records + extra["records"][split], None,
                    data.sources + extra["sources"][split]) for split, data in datasets.items()}, {"removed": []}
        with patch("modules.whiteboard.ink.training.train.ShapeDataset", return_value=original), \
                patch("modules.whiteboard.ink.training.external.merge_external", side_effect=merge):
            loaders = build_loaders(Path("unused"), (0,) * 3, (1,) * 3, 2, 0, 1, False, external=external)
        self.assertEqual(len(loaders["train"].dataset), 9)
        self.assertEqual(loaders["source_test/new"].dataset.records, new)

    def test_static_views_inherit_native_and_merged_origin_isolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            origins = [str((root / f"origin-{i}.png").resolve()) for i in range(3)]
            rows = [{"original": origin, "image": f"native-{i}.png",
                     "exclude_native": i == 0, "exclude_original": False}
                    for i, origin in enumerate(origins)]
            (root / "records.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
            original = ImageDataset([(root / f"existing-{i}.png", i) for i in range(8)], None)
            external = {"origins": {origin: ("train", 2, "verified/annotation") for origin in origins},
                        "sources": {split: [] for split in ("train", "val", "test")},
                        "native": {"directory": str(root), "removed": [{"path": origins[2]}]}}
            removed = {"removed": [{"path": str(root / "native-1.png")}]}
            with patch("modules.whiteboard.ink.training.train.ShapeDataset", return_value=original), \
                    patch("modules.whiteboard.ink.training.external.merge_external", side_effect=lambda data, *_: (data, removed)), \
                    patch("modules.whiteboard.ink.training.static_images.append_static_views", side_effect=lambda data, *_: (data, {})) as append:
                build_loaders(Path("unused"), (0,) * 3, (1,) * 3, 2, 0, 1, False,
                              external=external, static_images=root)
            self.assertEqual(append.call_args.args[3], set(origins))
            self.assertEqual(append.call_args.args[2][origins[0]], ("train", 2, "verified/annotation"))
