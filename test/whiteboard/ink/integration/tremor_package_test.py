"""通过已发布detail源包验证时间抖动数据的原子发布、源快照和训练clean配对。"""

from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json
from modules.whiteboard.ink.dataset.classification.render import render_image
from modules.whiteboard.ink.dataset.detail.package import generate_dataset as generate_detail
from modules.whiteboard.ink.dataset.tremor.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.training.external import load_external_packages


class TremorPublicationTests(unittest.TestCase):
    """进程替身用于小包契约测试；完整发布另用实际Rust渲染并核验指纹。"""

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.renderer = cls.root / "renderer"
        cls.renderer.write_text("test renderer fixture")
        reference, native, diagnostic, probe = [cls.root / name for name in ("reference", "native", "diagnostic", "probe")]
        for directory in (reference, native, diagnostic, probe):
            directory.mkdir()
        write_json(reference / "manifest.json", {"renderer": file_record(cls.renderer)})
        (native / "records.jsonl").write_text("")
        write_json(native / "manifest.json", {"renderer": {}, "reserved_pixel_sha256": [], "records": file_record(native / "records.jsonl")})
        for directory in (diagnostic, probe):
            (directory / "cases.jsonl").write_text("")

        def renderer_fixture(renderer, requests):
            for request in requests:
                render_image(request["paths"], 3).save(request["output"])

        cls.patches = ExitStack()
        for module in ("detail.package", "detail.reserved", "tremor.package"):
            cls.patches.enter_context(patch(f"modules.whiteboard.ink.dataset.{module}.render_requests", side_effect=renderer_fixture))
        cls.source, cls.output = cls.root / "source", cls.root / "data"
        generate_detail(cls.renderer, reference, native, diagnostic, probe, cls.source, per_class=10)
        cls.manifest = generate_dataset(cls.source, cls.renderer, cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.patches.close()
        cls.temporary.cleanup()

    def test_accepted_pairs_keep_original_parent_groups_and_product_inputs(self):
        self.assertEqual(validate_dataset(self.output), self.manifest["counts"])
        self.assertEqual(self.manifest["counts"]["materialized_views"], 420)
        external = load_external_packages([self.source, self.output])
        self.assertEqual(external["native_sources"][str(self.output)], file_record(self.renderer))
        tremor_sources = {source for split in external["sources"].values() for source in split if source.startswith("synthetic_tremor")}
        self.assertEqual(tremor_sources, {"synthetic_tremor/synthetic_geometry"})
        rows = [json.loads(line) for line in (self.output / "train.jsonl").read_text().splitlines()]
        self.assertTrue(rows)
        for row in rows:
            image = str((self.output / row["image"]).resolve())
            self.assertEqual(external["references"][image], (self.output / row["clean_image"]).resolve())

    def test_renderer_mismatch_and_failure_never_publish_partial_package(self):
        wrong = self.root / "wrong-renderer"
        wrong.write_text("wrong renderer")
        with self.assertRaisesRegex(ValueError, "渲染器"):
            generate_dataset(self.source, wrong, self.root / "wrong")
        with patch("modules.whiteboard.ink.dataset.tremor.package.render_requests", side_effect=subprocess.CalledProcessError(1, "renderer")):
            with self.assertRaises(subprocess.CalledProcessError):
                generate_dataset(self.source, self.renderer, self.root / "failed")
        self.assertFalse((self.root / "failed").exists())
        self.assertFalse(list(self.root.glob(".classification-build-*")))

    def test_rehashed_modified_timestamp_cannot_keep_the_original_target_protocol(self):
        import shutil
        modified = self.root / "modified"
        shutil.copytree(self.output, modified)
        path = modified / "train.jsonl"
        rows = list(map(json.loads, path.read_text().splitlines()))
        rows[0]["timestamps_seconds"][1] += .001
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        manifest = json.loads((modified / "manifest.json").read_text())
        manifest["files"][path.name] = file_record(path)
        write_json(modified / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "完整遍历"):
            validate_dataset(modified)


if __name__ == "__main__":
    unittest.main()
