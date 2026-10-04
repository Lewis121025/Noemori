"""外部原生视图必须替换真实矢量输入，并保留没有轨迹的原始栅格来源。"""

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json
from modules.whiteboard.ink.training.data import ImageDataset
from modules.whiteboard.ink.training.external import load_external_native, merge_external
from modules.whiteboard.ink.training.native_images import pixel_hash


class ExternalNativeTests(unittest.TestCase):
    """没有原矢量的中文/扫描来源不能通过渲染器伪造轨迹或新增样本。"""

    def test_vector_replacement_and_new_raster_source_reuse_the_same_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            vector_dir, raster_dir, bundle = root / "vectors", root / "rasters", root / "native"
            for directory in (vector_dir, raster_dir, bundle):
                directory.mkdir()
            paths = [vector_dir / "input.png", raster_dir / "input.png", bundle / "rendered.png"]
            for path in paths:
                Image.new("RGB", (224, 224), "white").save(path)
            v, r, target = paths
            row = {"original": str(v), "original_sha256": file_record(v)["sha256"], "label": "circle", "split": "train",
                   "image": target.name, "image_sha256": file_record(target)["sha256"], "pixel_sha256": pixel_hash(target),
                   "exclude_native": False, "exclude_original": False}
            (bundle / "records.jsonl").write_text(json.dumps(row) + "\n")
            fingerprint = {"bytes": 1, "sha256": "a" * 64}
            write_json(bundle / "manifest.json", {"sources": [{"directory": str(vector_dir), "manifest": fingerprint}],
                                                    "records": file_record(bundle / "records.jsonl")})
            data = {"records": {"train": [(v, 1), (r, 7)], "val": [], "test": []},
                    "sources": {"train": ["vector", "raster"], "val": [], "test": []},
                    "vectors": {str(v): [[[0, 0], [1, 1]]]}, "pixels": {},
                    "metadata": [{"directory": str(d), "manifest": fingerprint} for d in (vector_dir, raster_dir)]}
            result = load_external_native(bundle, data)
            self.assertEqual(result["records"]["train"], [(target, 1), (r, 7)])
            self.assertEqual(result["sources"]["train"], ["vector", "raster"])
            self.assertEqual(len(result["records"]["train"]), 2)

    def test_missing_vector_source_fingerprint_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "records.jsonl").write_text("")
            write_json(root / "manifest.json", {"sources": [], "records": file_record(root / "records.jsonl")})
            data = {"metadata": [{"directory": str(root / "source"), "manifest": {}}],
                    "vectors": {str(root / "source" / "image.png"): [[[0, 0], [1, 1]]]}}
            with self.assertRaisesRegex(ValueError, "快照"):
                load_external_native(root, data)

    def test_product_rendered_pairs_require_the_same_renderer_and_keep_their_reference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, bundle = root / "detail", root / "cache"
            source.mkdir()
            bundle.mkdir()
            path = source / "input.png"
            Image.new("RGB", (224, 224), "white").save(path)
            renderer = {"bytes": 7, "sha256": "b" * 64}
            (bundle / "records.jsonl").write_text("")
            write_json(bundle / "manifest.json", {"sources": [], "renderer": renderer,
                                                    "records": file_record(bundle / "records.jsonl")})
            data = {"metadata": [{"directory": str(source), "manifest": {}}],
                    "native_sources": {str(source): renderer}, "vectors": {str(path): [[[0, 0], [1, 1]]]},
                    "records": {"train": [(path, 4)], "val": [], "test": []},
                    "sources": {"train": ["detail"], "val": [], "test": []},
                    "pixels": {str(path): pixel_hash(path)}, "references": {str(path): path}}
            result = load_external_native(bundle, data)
            self.assertEqual(result["records"]["train"], [(path, 4)])
            self.assertEqual(result["references"][str(path)], path)
            result["native_sources"][str(source)] = {"bytes": 8, "sha256": "c" * 64}
            with self.assertRaisesRegex(ValueError, "渲染器"):
                load_external_native(bundle, result)

    def test_clean_reference_leak_removes_the_derived_training_view(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for i, color in enumerate(("black", "red", "yellow", "green", "blue")):
                path = root / f"{i}.png"
                Image.new("RGB", (224, 224), color).save(path)
                paths.append(path)
            train, clean, val, test, noisy = paths
            base = {"train": ImageDataset([(train, 4)], None),
                    "val": ImageDataset([(clean, 4), (val, 4)], None),
                    "test": ImageDataset([(test, 4)], None)}
            external = {"records": {"train": [(noisy, 4)], "val": [], "test": []},
                        "sources": {"train": ["detail"], "val": [], "test": []},
                        "pixels": {str(noisy): pixel_hash(noisy), str(clean): pixel_hash(clean)},
                        "references": {str(noisy): clean}}
            result, exclusions = merge_external(base, external)
            self.assertEqual(result["train"].records, [(train, 4)])
            self.assertEqual(result["val"].records, [(val, 4)])
            self.assertEqual({r["path"] for r in exclusions["removed"]}, {str(clean), str(noisy)})
