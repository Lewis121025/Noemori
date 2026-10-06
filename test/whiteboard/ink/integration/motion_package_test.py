"""小型已校验来源覆盖motion发布、旧holdout保护、真实来源身份及篡改拒绝。"""

from contextlib import ExitStack
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json
from modules.whiteboard.ink.dataset.classification.render import render_image
from modules.whiteboard.ink.dataset.detail.package import generate_dataset as generate_detail
from modules.whiteboard.ink.dataset.detail.reserved import pixel_hash
from modules.whiteboard.ink.dataset.motion.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.motion.reservation import collect_reservation
from modules.whiteboard.ink.training.external import load_external_native, load_external_packages


class MotionPublicationTests(unittest.TestCase):
    """渲染进程用小型替身；来源验证、原子发布、身份及散列规则均执行生产逻辑。"""

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.renderer = cls.root / "renderer"
        cls.renderer.write_text("test renderer fixture")
        reference, native, diagnostic, probe = [cls.root/name for name in ("reference", "native", "diagnostic", "probe")]
        for directory in (reference, native, diagnostic, probe):
            directory.mkdir()
        write_json(reference/"manifest.json", {"renderer": file_record(cls.renderer)})
        (native/"records.jsonl").write_text("")
        write_json(native/"manifest.json", {"renderer": {}, "reserved_pixel_sha256": [], "records": file_record(native/"records.jsonl")})
        for directory in (diagnostic, probe):
            (directory/"cases.jsonl").write_text("")

        def renderer_fixture(renderer, requests):
            for request in requests:
                render_image(request["paths"], 3).save(request["output"])

        cls.patches = ExitStack()
        for module in ("detail.package", "detail.reserved", "motion.package"):
            cls.patches.enter_context(patch(f"modules.whiteboard.ink.dataset.{module}.render_requests", side_effect=renderer_fixture))
        cls.source, cls.output, cls.cache = cls.root/"source", cls.root/"data", cls.root/"cache"
        generate_detail(cls.renderer, reference, native, diagnostic, probe, cls.source, per_class=10)
        cls.old_files = {name: file_record(cls.source/name) for name in ("manifest.json", "train.jsonl", "val.jsonl", "test.jsonl")}
        cls.cache.mkdir()
        original = json.loads((cls.source/"test.jsonl").read_text().splitlines()[0])
        shutil.copyfile(cls.source/original["image"], cls.cache/"rendered.png")
        row = {"original": str(cls.source/original["image"]), "original_sha256": original["image_sha256"],
               "original_pixel_sha256": original["pixel_sha256"], "image": "rendered.png",
               "image_sha256": file_record(cls.cache/"rendered.png")["sha256"], "pixel_sha256": pixel_hash(cls.cache/"rendered.png"),
               "split": "test", "label": original["label"], "sample_id": original["sample_id"], "group_id": original["group_id"],
               "exclude_native": False, "exclude_original": False}
        (cls.cache/"records.jsonl").write_text(json.dumps(row)+"\n")
        write_json(cls.cache/"manifest.json", {"sources": [{"directory": str(cls.source), "manifest": file_record(cls.source/"manifest.json")}],
                                              "renderer": file_record(cls.renderer), "reserved_pixel_sha256": [],
                                              "records": file_record(cls.cache/"records.jsonl")})
        cls.manifest = generate_dataset([cls.source], [cls.cache], cls.renderer, cls.output, per_class=10)

    @classmethod
    def tearDownClass(cls):
        cls.patches.close()
        cls.temporary.cleanup()

    def test_publish_complete_views_keep_old_holdout_files_and_clean_references(self):
        self.assertEqual(validate_dataset(self.output), self.manifest["counts"])
        self.assertEqual(self.manifest["counts"]["analytic_parents"], 80)
        self.assertEqual(self.manifest["counts"]["materialized_views"], 720)
        self.assertEqual(self.manifest["counts"]["real_handwritten_drawings"], 0)
        for name, expected in self.old_files.items():
            self.assertEqual(file_record(self.source/name), expected)
        external = load_external_native(self.cache, load_external_packages([self.source, self.output]))
        self.assertEqual(external["native_sources"][str(self.output)], file_record(self.renderer))
        self.assertTrue(any(source == "synthetic_motion/synthetic_geometry" for source in external["sources"]["train"]))
        for image, reference in external["references"].items():
            if Path(image).is_relative_to(self.output):
                self.assertTrue(reference.is_relative_to(self.output))
        reservation = json.loads((self.output/"reservation.json").read_text())
        old = reservation["source_snapshots"][0]
        self.assertEqual(old["row_counts_by_split"]["test"], len((self.source/"test.jsonl").read_text().splitlines()))

    def test_failed_product_render_never_publishes_a_partial_package(self):
        with patch("modules.whiteboard.ink.dataset.motion.package.render_requests", side_effect=subprocess.CalledProcessError(1, "renderer")):
            with self.assertRaises(subprocess.CalledProcessError):
                generate_dataset([self.source], [self.cache], self.renderer, self.root/"failed", per_class=10)
        self.assertFalse((self.root/"failed").exists())
        self.assertFalse(list(self.root.glob(".classification-build-*")))

    def test_rehashed_time_geometry_or_pair_tampering_is_rejected(self):
        for field in ("timestamps_seconds", "clean_sample_id", "source_label"):
            with self.subTest(field=field), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                copy = Path(temporary)/"data"
                shutil.copytree(self.output, copy)
                path = copy/"train.jsonl"
                rows = list(map(json.loads, path.read_text().splitlines()))
                if field == "timestamps_seconds":
                    rows[0][field][1] += .001
                elif field == "clean_sample_id":
                    rows[0][field] = "f"*32
                else:
                    rows[0][field] = "other" if rows[0][field] != "other" else "line"
                path.write_text("".join(json.dumps(row)+"\n" for row in rows))
                manifest = json.loads((copy/"manifest.json").read_text())
                manifest["files"][path.name] = file_record(path)
                write_json(copy/"manifest.json", manifest)
                with self.assertRaisesRegex(ValueError, "原始参数"):
                    validate_dataset(copy)

    def test_rehashed_reservation_cannot_change_old_pixel_protection(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            copy = Path(temporary)/"data"
            shutil.copytree(self.output, copy)
            path = copy/"reservation.json"
            reservation = json.loads(path.read_text())
            reservation["protected_pixels"].append("f"*64)
            write_json(path, reservation)
            manifest = json.loads((copy/"manifest.json").read_text())
            manifest["files"][path.name] = file_record(path)
            write_json(copy/"manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "保留索引"):
                validate_dataset(copy)

    def test_rehashed_native_label_cannot_relabel_an_original_source_record(self):
        records, manifest_path = self.cache/"records.jsonl", self.cache/"manifest.json"
        original_records, original_manifest = records.read_bytes(), manifest_path.read_bytes()
        try:
            row = json.loads(records.read_text())
            row["label"] = "other" if row["label"] != "other" else "line"
            records.write_text(json.dumps(row)+"\n")
            manifest = json.loads(manifest_path.read_text())
            manifest["records"] = file_record(records)
            write_json(manifest_path, manifest)
            with self.assertRaisesRegex(ValueError, "标签、划分"):
                collect_reservation([self.source], [self.cache], self.renderer)
        finally:
            records.write_bytes(original_records)
            manifest_path.write_bytes(original_manifest)

    def test_historical_renderer_pixels_remain_protected_without_claiming_renderer_equivalence(self):
        manifest_path = self.cache/"manifest.json"
        original_manifest = manifest_path.read_bytes()
        old_renderer = {"bytes": 17, "sha256": "a"*64}
        try:
            manifest = json.loads(original_manifest)
            manifest["renderer"] = old_renderer
            write_json(manifest_path, manifest)
            reservation = collect_reservation([self.source], [self.cache], self.renderer)
            cache = next(row for row in reservation["source_snapshots"] if row["kind"] == "native_cache")
            self.assertEqual(cache["renderer"], old_renderer)
            self.assertEqual(reservation["renderer"]["binary"], file_record(self.renderer))
            original = json.loads((self.cache/"records.jsonl").read_text())
            self.assertIn(["test", original["label"]], reservation["pixels"][original["pixel_sha256"]])
        finally:
            manifest_path.write_bytes(original_manifest)

    def test_historical_cache_pixel_drift_is_rejected_even_with_unchanged_record_identity(self):
        image = self.cache/"rendered.png"
        original = image.read_bytes()
        try:
            image.write_bytes(original + b"tampered")
            with self.assertRaisesRegex(ValueError, "图像SHA"):
                collect_reservation([self.source], [self.cache], self.renderer)
        finally:
            image.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
