"""真实中文灰度归一化及作者/字符身份的纯逻辑契约。"""

from collections import Counter
import io
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.chinese.raster import normalize_image
from modules.whiteboard.ink.dataset.chinese.schema import parse_member, writer_split


class ChineseRasterTests(unittest.TestCase):
    """检查弱扫描灰度保持字形、白底黑墨与等比裁剪，空白不形成负例。"""

    def test_grayscale_is_inverted_and_aspect_ratio_is_preserved(self):
        source = Image.new("L", (64, 64), 0)
        ImageDraw.Draw(source).rectangle((15, 20, 48, 40), outline=90, width=2)
        buffer = io.BytesIO()
        source.save(buffer, format="JPEG", quality=95)
        result, info = normalize_image(buffer.getvalue())
        self.assertEqual((result.size, result.mode), ((224, 224), "RGB"))
        self.assertTrue(info["usable"])
        self.assertEqual(result.getpixel((0, 0)), (255, 255, 255))
        width, height = info["rendered_size"]
        box = info["source_ink_bbox"]
        self.assertAlmostEqual(width / height, (box[2]-box[0]) / (box[3]-box[1]), delta=.02)
        self.assertEqual(info["input_kind"], "source_raster")

    def test_blank_and_invalid_formats_are_not_silently_accepted(self):
        blank = Image.new("L", (64, 64), 0)
        buffer = io.BytesIO()
        blank.save(buffer, format="JPEG")
        _, info = normalize_image(buffer.getvalue())
        self.assertFalse(info["usable"])
        buffer = io.BytesIO()
        blank.save(buffer, format="PNG")
        with self.assertRaisesRegex(ValueError, "灰度JPEG"):
            normalize_image(buffer.getvalue())

    def test_writer_split_uses_exact_eighty_ten_ten_and_member_limits(self):
        self.assertEqual(Counter(writer_split(i) for i in range(1, 101)), {"train": 80, "val": 10, "test": 10})
        self.assertEqual(parse_member("Raw Dataset/Locate{100,10,15}.jpg"), (100, 10, 15))
        for name in ("Raw Dataset/Locate{01,1,1}.jpg", "Raw Dataset/Locate{101,1,1}.jpg", "../Locate{1,1,1}.jpg"):
            with self.assertRaises(ValueError):
                parse_member(name)


if __name__ == "__main__":
    unittest.main()
