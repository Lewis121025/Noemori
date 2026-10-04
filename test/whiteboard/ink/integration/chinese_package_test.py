"""官方形态的小型7z夹具检验中文来源、作者隔离、复杂字映射和像素去重。"""

from contextlib import ExitStack
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import py7zr
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.chinese.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.chinese.schema import writer_split
from modules.whiteboard.ink.dataset.classification.acquire import file_record, write_json


class ChinesePublicationTests(unittest.TestCase):
    """跨作者同JPEG全部隔离，简单字类留review；修改标签或作者不能靠重写清单绕过。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        members = self.root / "members"
        members.mkdir()
        writers = [next(i for i in range(1, 101) if writer_split(i) == split) for split in ("train", "val", "test")]
        with py7zr.SevenZipFile(self.sources / "Raw Dataset.7z", "w") as archive:
            for index, writer in enumerate(writers):
                for code in (1, 2, 6):
                    image = Image.new("L", (64, 64), 0)
                    draw = ImageDraw.Draw(image)
                    shift = 0 if code == 1 and index < 2 else index + code
                    draw.line([(10, 12), (48, 18+shift), (25, 48), (45, 44-shift)], fill=180, width=2)
                    data = io.BytesIO()
                    image.save(data, format="JPEG", quality=95)
                    path = members / f"{writer}-{code}.jpg"
                    path.write_bytes(data.getvalue())
                    archive.write(path, f"Raw Dataset/Locate{{{writer},1,{code}}}.jpg")
        (self.sources / "READ ME.txt").write_text("官方采集说明夹具")
        (self.sources / "Preprocessing Code.zip").write_bytes(b"source code evidence fixture")
        write_json(self.sources / "source-metadata.json", {"id": 10280831, "license": {"name": "CC BY 4.0"}})
        write_json(self.sources / "manifest.json", {"source": "newcastle-handwritten-chinese-numbers-v1", "license": "CC-BY-4.0"})
        hashes = {name: file_record(self.sources / name)["sha256"] for name in (
            "Raw Dataset.7z", "READ ME.txt", "Preprocessing Code.zip", "source-metadata.json")}
        self.patches = ExitStack()
        prefix = "modules.whiteboard.ink.dataset.chinese.package"
        self.patches.enter_context(patch(prefix + ".SOURCE_HASHES", hashes))
        self.patches.enter_context(patch(prefix + ".EXPECTED_IMAGES", 9))
        self.patches.enter_context(patch(prefix + ".EXPECTED_WRITERS", 3))

    def tearDown(self):
        self.patches.close()
        self.temporary.cleanup()

    def test_original_raster_mapping_grouping_and_cross_writer_duplicates(self):
        output = self.root / "data"
        manifest = generate_dataset(self.sources, output)
        self.assertEqual(validate_dataset(output), manifest["counts"])
        self.assertEqual(manifest["counts"]["source_images"], 9)
        self.assertEqual(manifest["counts"]["source_writer_ids"], 3)
        rows = [json.loads(line) for s in ("train", "val", "test", "review") for line in (output / f"{s}.jsonl").read_text().splitlines()]
        self.assertTrue(all(r["paths"] is None for r in rows))
        self.assertTrue(all(r["split"] == "review" and r["label"] is None for r in rows if r["source_label"] == "一"))
        self.assertTrue(all(r["split"] == "review" for r in rows if r["source_label"] == "零" and r["assigned_split"] in ("train", "val")))
        self.assertTrue(all(r["label"] == "other" and r["annotation_kind"] == "mapped_source_character" for r in rows if r["split"] != "review"))
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            generate_dataset(self.sources, output)

    def test_rehashed_wrong_supervision_and_original_bytes_are_rejected(self):
        output = self.root / "data"
        generate_dataset(self.sources, output)
        path = output / "train.jsonl"
        original = path.read_text()
        rows = list(map(json.loads, original.splitlines()))
        self.assertTrue(rows)
        rows[0]["label"] = "circle"
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["files"][path.name] = file_record(path)
        write_json(output / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "监督标签"):
            validate_dataset(output)
        path.write_text(original)
        manifest["files"][path.name] = file_record(path)
        write_json(output / "manifest.json", manifest)
        (output / rows[0]["provenance"]["original_file"]).write_bytes(b"corrupted JPEG")
        with self.assertRaisesRegex(ValueError, "原JPEG"):
            validate_dataset(output)


if __name__ == "__main__":
    unittest.main()
