"""HDS固定归档到栅格分类包的真实来源、用户隔离和内容完整性检查。"""

from collections import Counter
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.classification.acquire import file_record
from modules.whiteboard.ink.dataset.real_shapes.package import generate_dataset, validate_dataset
from modules.whiteboard.ink.dataset.real_shapes.schema import REVISION


class HdsPublicationTests(unittest.TestCase):
    """小型来源夹具模拟作者用户划分和未知拉伸，绝不依赖训练预测。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.archive = self.root / "hds.tar.gz"
        readme = b"HDS data CC BY 4.0; code MIT; source fixture"
        members = {"README.md": readme, "Datasheet_for_Datasets.HDS.pdf": b"fixture evidence"}
        counts = Counter()
        for index, writer in enumerate(("aly", "crt", "u01")):
            for label, repetition in (("ellipse", 1), ("ellipse", 2), ("rectangle", 1), ("triangle", 1), ("other", 1)):
                image = Image.new("RGBA", (70, 70), "white")
                draw = ImageDraw.Draw(image)
                if label == "ellipse":
                    if repetition == 1:
                        draw.ellipse((10, 24-index, 60, 46+index), outline="black", width=2)
                        points = [[.1,.5],[.5,.7],[.9,.5],[.5,.3]]
                    else:
                        draw.ellipse((10, 10, 60, 60), outline="black", width=2)
                        points = [[.1,.5],[.5,.89],[.9,.5],[.5,.11]]
                elif label == "rectangle":
                    draw.rectangle((10,15,60,55), outline="black", width=2)
                    points = [[.1,.1],[.9,.1],[.9,.9],[.1,.9]]
                elif label == "triangle":
                    draw.line([(10,60),(30+index*5,10),(60,60),(10,60)], fill="black", width=2)
                    points = [[.1,.9],[.5,.1],[.9,.9],[.1,.9]]
                else:
                    draw.line([(10,20),(60,20),(35,20),(35,60)], fill="black", width=2)
                    points = None
                stream = io.BytesIO(); image.save(stream, format="PNG")
                name = f"{label}.{writer}.{repetition:04}"
                members[f"data/user.{writer}/images/{label}/{name}.png"] = stream.getvalue()
                if points:
                    members[f"data/user.{writer}/vertices/{label}/{name}.csv"] = "\n".join(f"{x},{y}" for x,y in points).encode()
                counts[label] += 1
        with tarfile.open(self.archive, "w:gz") as archive:
            for relative, data in sorted(members.items()):
                info = tarfile.TarInfo(f"hand-drawn-shapes-dataset-{REVISION}/{relative}")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.patches = ExitStack()
        prefix = "modules.whiteboard.ink.dataset.real_shapes.package"
        self.patches.enter_context(patch(prefix + ".ARCHIVE_SHA256", file_record(self.archive)["sha256"]))
        self.patches.enter_context(patch(prefix + ".README_SHA256", hashlib.sha256(readme).hexdigest()))
        self.patches.enter_context(patch(prefix + ".EXPECTED_COUNTS", dict(counts)))

    def tearDown(self):
        self.patches.close()
        self.temporary.cleanup()

    def test_reproducible_publication_keeps_unknown_derivation_and_writer_assignments(self):
        first, second = self.root / "first", self.root / "second"
        manifest = generate_dataset(self.archive, first)
        generate_dataset(self.archive, second)
        self.assertEqual(manifest["counts"]["records"], 15)
        self.assertIsNone(manifest["counts"]["independent_original_drawing_count"])
        self.assertEqual(manifest["counts"]["unknown_original_or_stretched_records"], 12)
        self.assertEqual(manifest["counts"]["assigned_writers"], {"train":["aly"], "val":["crt"], "test":["u01"]})
        for path in first.rglob("*"):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (second / path.relative_to(first)).read_bytes())
        self.assertEqual(validate_dataset(first), manifest["counts"])

    def test_near_circles_other_and_cross_split_identical_pixels_are_not_training_labels(self):
        destination = self.root / "data"
        generate_dataset(self.archive, destination)
        with (destination / "review.jsonl").open() as handle:
            review = [json.loads(line) for line in handle]
        self.assertTrue(all(r["label"] is None for r in review))
        self.assertEqual(sum(r["source_label"] == "other" for r in review), 3)
        self.assertEqual(sum(r["source_label"] == "rectangle" for r in review), 3)
        self.assertTrue(all(r["annotation_status"] == "excluded_cross_split_duplicate" for r in review if r["source_label"] == "rectangle"))
        self.assertEqual(sum(r["source_label"] == "ellipse" for r in review), 3)
        for split in ("train", "val", "test"):
            with (destination / f"{split}.jsonl").open() as handle:
                self.assertEqual({json.loads(line)["label"] for line in handle}, {"triangle", "ellipse"})

    def test_rehashed_wrong_label_and_corrupted_image_are_rejected(self):
        destination = self.root / "data"
        generate_dataset(self.archive, destination)
        train = destination / "train.jsonl"
        original = train.read_text(); lines = original.splitlines()
        record = json.loads(lines[0]); record["label"] = "circle"; lines[0] = json.dumps(record)
        train.write_text("\n".join(lines) + "\n")
        manifest = json.loads((destination / "manifest.json").read_text())
        manifest["files"]["train.jsonl"] = file_record(train)
        (destination / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "人工类别/顶点规则"):
            validate_dataset(destination)
        train.write_text(original)
        manifest["files"]["train.jsonl"] = file_record(train)
        (destination / "manifest.json").write_text(json.dumps(manifest))
        (destination / record["image"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "图像SHA"):
            validate_dataset(destination)


if __name__ == "__main__":
    unittest.main()
