"""小型产品渲染替身覆盖合成细节包的配对、保留像素隔离和原子失败。"""

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
from modules.whiteboard.ink.dataset.detail.geometry import clean_path, parent_specs
from modules.whiteboard.ink.dataset.detail.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.detail.reserved import pixel_hash


class DetailPublicationTests(unittest.TestCase):
    """测试替身仅替代进程；生产全包使用实际Rust二进制并独立核验指纹。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.renderer = self.root / "renderer"
        self.renderer.write_text("test renderer fixture")
        self.reference, self.native, self.diagnostic, self.probe = [self.root/name for name in ("reference", "native", "diagnostic", "probe")]
        for directory in (self.reference, self.native, self.diagnostic, self.probe):
            directory.mkdir()
        write_json(self.reference/"manifest.json", {"renderer": file_record(self.renderer)})
        self.blocked_parent = next(p for p in parent_specs(10) if p["label"] == "ellipse" and p["assigned_split"] == "train")
        render_image([clean_path(self.blocked_parent["parameters"])], 3).save(self.native/"heldout.png")
        self.reserved_pixel = pixel_hash(self.native/"heldout.png")
        row = {"sample_id": "heldout", "split": "test", "image": "heldout.png", "pixel_sha256": self.reserved_pixel,
               "original_pixel_sha256": self.reserved_pixel, "image_sha256": file_record(self.native/"heldout.png")["sha256"]}
        (self.native/"records.jsonl").write_text(json.dumps(row)+"\n")
        write_json(self.native/"manifest.json", {"renderer": {"sha256": "old renderer"}, "reserved_pixel_sha256": [],
                                                "records": file_record(self.native/"records.jsonl")})
        for directory in (self.diagnostic, self.probe):
            paths = [[[0, 0], [60, 0], [20, 10], [35, 50]]]
            render_image(paths, 3).save(directory/"case.png")
            (directory/"cases.jsonl").write_text(json.dumps({"paths": paths, "image": "case.png", "detail": "clean"})+"\n")

        def renderer_fixture(renderer, requests):
            self.assertEqual(renderer, self.renderer)
            for request in requests:
                render_image(request["paths"], 3).save(request["output"])

        self.patches = ExitStack()
        self.patches.enter_context(patch("modules.whiteboard.ink.dataset.detail.package.render_requests", side_effect=renderer_fixture))
        self.patches.enter_context(patch("modules.whiteboard.ink.dataset.detail.reserved.render_requests", side_effect=renderer_fixture))

    def tearDown(self):
        self.patches.close()
        self.temporary.cleanup()

    def _generate(self, output):
        return generate_dataset(self.renderer, self.reference, self.native, self.diagnostic, self.probe, output, per_class=10)

    def test_known_targets_clean_pairs_and_reserved_parent_isolation(self):
        output = self.root/"data"
        manifest = self._generate(output)
        self.assertEqual(validate_dataset(output), manifest["counts"])
        self.assertEqual(manifest["counts"]["materialized_views"], 640)
        self.assertEqual(manifest["counts"]["analytic_parents"], 70)
        rows = [json.loads(line) for split in ("train", "val", "test", "review") for line in (output/f"{split}.jsonl").read_text().splitlines()]
        blocked = [r for r in rows if r["parent_id"] == self.blocked_parent["parent_id"]]
        self.assertEqual(len(blocked), 10)
        self.assertTrue(all(r["split"] == "review" and r["label"] is None for r in blocked))
        indexed = {r["sample_id"]: r for r in rows}
        for row in rows:
            if row["split"] != "review":
                clean = indexed[row["clean_sample_id"]]
                self.assertEqual(clean["split"], row["split"])
                self.assertEqual(clean["parent_id"], row["parent_id"])
                self.assertNotEqual(row["clean_pixel_sha256"], self.reserved_pixel)

    def test_failed_product_render_does_not_publish_partial_dataset(self):
        output = self.root/"failed"
        with patch("modules.whiteboard.ink.dataset.detail.package.render_requests", side_effect=subprocess.CalledProcessError(1, "renderer")):
            with self.assertRaises(subprocess.CalledProcessError):
                self._generate(output)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob(".classification-build-*")))

    def test_rehashed_modified_path_cannot_keep_the_old_known_target(self):
        output = self.root/"data"
        self._generate(output)
        path = output/"train.jsonl"
        rows = list(map(json.loads, path.read_text().splitlines()))
        rows[0]["paths"][0].pop()
        path.write_text("".join(json.dumps(r)+"\n" for r in rows))
        manifest = json.loads((output/"manifest.json").read_text())
        manifest["files"][path.name] = file_record(path)
        write_json(output/"manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "完整单笔"):
            validate_dataset(output)


if __name__ == "__main__":
    unittest.main()
