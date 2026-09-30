"""真实评测包原子发布、完整性和来源语义的离线集成测试。"""

import hashlib
import json
from pathlib import Path
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.real_eval.package import acquire_dataset, validate_dataset
from modules.whiteboard.ink.dataset.real_eval.sources import TAGS_URL, REFERENCES_URL, ROUGH_URL

PACKAGE = "modules.whiteboard.ink.dataset.real_eval.package"
TAGS = (b'Name,Author,Preferred Attribution,Author Homepage,Copyright,Source,Genre,Background,Cleaned\n'
        b'Shape_01,Artist,,,CC-BY-4.0,source,Art,Paper,Yes\n')
PAGE = (b'<a href="../Benchmark_Dataset/GT/Shape_01_A_norm_cleaned.svg">a</a>'
        b'<a href="../Benchmark_Dataset/GT/Shape_01_B_norm_cleaned.svg">b</a>')
ROUGH_PAGE = (b'<a href="../Benchmark_Dataset/Rough/SVG/Shape_01_norm_rough.svg">shape</a>'
              b'<a href="../Benchmark_Dataset/Rough/SVG/Shape_01_norm_full.svg">full</a>')
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0L5 5"/></svg>'


def fixture_fetch(url: str, context: ssl.SSLContext | None = None) -> bytes:
    """固定元数据与路径，确保集成测试无需联网。"""
    return {TAGS_URL: TAGS, REFERENCES_URL: PAGE, ROUGH_URL: ROUGH_PAGE}.get(url, SVG)


class RealPackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "evaluation"
        transport = patch(PACKAGE + "._transport", return_value=(ssl.create_default_context(), b'test certificate'))
        transport.start()
        self.addCleanup(transport.stop)
        fetch = patch(PACKAGE + ".fetch", side_effect=fixture_fetch)
        self.fetch = fetch.start()
        self.addCleanup(fetch.stop)

    def test_round_trip_retains_bytes_multi_reference_and_evaluation_identity(self) -> None:
        manifest = acquire_dataset(self.output)
        self.assertEqual(validate_dataset(self.output), manifest["counts"])
        record = json.loads((self.output / "eval.jsonl").read_text())
        self.assertEqual(len(record["references"]), 2)
        self.assertEqual(record["split"], "test")
        self.assertIsNone(record["annotation"]["focus_stroke_id"])
        self.assertEqual((self.output / record["input"]["path"]).read_bytes(), SVG)
        self.assertEqual(manifest["counts"]["svg_files"], 4)

    def test_refuses_existing_output_and_preserves_files(self) -> None:
        self.output.mkdir()
        sentinel = self.output / "mine.txt"
        sentinel.write_text("keep")
        with self.assertRaisesRegex(ValueError, "覆盖"):
            acquire_dataset(self.output)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_network_failure_cleans_staging_and_never_publishes(self) -> None:
        def fail_svg(url: str, context: ssl.SSLContext | None = None) -> bytes:
            if url.endswith('.svg'):
                raise OSError("offline")
            return fixture_fetch(url, context)
        self.fetch.side_effect = fail_svg
        with self.assertRaisesRegex(OSError, "offline"):
            acquire_dataset(self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_quarantines_misaligned_reference_without_independently_rescaling(self) -> None:
        def misaligned(url: str, context: ssl.SSLContext | None = None) -> bytes:
            return SVG.replace(b'100 100', b'200 200') if '_B_norm_cleaned' in url else fixture_fetch(url, context)
        self.fetch.side_effect = misaligned
        manifest = acquire_dataset(self.output)
        self.assertEqual((self.output / 'eval.jsonl').read_text(), '')
        record = json.loads((self.output / 'review.jsonl').read_text())
        self.assertEqual(record['split'], 'review')
        self.assertEqual(manifest['counts']['review_sketches'], 1)
        validate_dataset(self.output)

    def test_accepts_viewbox_serialization_roundoff_without_changing_svg(self) -> None:
        rounded = SVG.replace(b'100 100', b'100 99.999998')
        def rounding(url: str, context: ssl.SSLContext | None = None) -> bytes:
            return rounded if '_B_norm_cleaned' in url else fixture_fetch(url, context)
        self.fetch.side_effect = rounding
        acquire_dataset(self.output)
        record = json.loads((self.output / 'eval.jsonl').read_text())
        self.assertEqual((self.output / record['references'][1]['path']).read_bytes(), rounded)
        validate_dataset(self.output)

    def test_detects_file_tampering(self) -> None:
        acquire_dataset(self.output)
        record = json.loads((self.output / "eval.jsonl").read_text())
        (self.output / record["references"][0]["path"]).write_bytes(SVG + b' ')
        with self.assertRaisesRegex(ValueError, "被修改"):
            validate_dataset(self.output)

    def test_detects_forged_pen_up_scope_even_when_json_hash_is_refreshed(self) -> None:
        acquire_dataset(self.output)
        path = self.output / "eval.jsonl"
        record = json.loads(path.read_text())
        record["annotation"]["focus_stroke_id"] = "invented"
        path.write_text(json.dumps(record) + '\n')
        manifest_path = self.output / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["eval.jsonl"] = {"bytes": path.stat().st_size,
                                              "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "任务范围"):
            validate_dataset(self.output)


if __name__ == "__main__":
    unittest.main()
