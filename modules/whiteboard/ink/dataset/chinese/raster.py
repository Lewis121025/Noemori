"""归一化官方64px白墨黑底扫描栅格；不恢复或虚构白板轨迹。"""

import io

from PIL import Image, ImageChops, ImageOps


def normalize_image(data: bytes) -> tuple[Image.Image, dict]:
    """线性拉伸灰度、反相并等比置于224RGB；空白/极弱图保留质量标记，格式错误抛ValueError。"""
    with Image.open(io.BytesIO(data)) as source:
        if source.format != "JPEG" or source.size != (64, 64) or source.mode != "L":
            raise ValueError("中文原图必须为64×64灰度JPEG")
        source.load()
        minimum, maximum = source.getextrema()
        ink = ImageOps.autocontrast(source, cutoff=0)
    mask = ink.point(lambda value: 255 if value >= 20 else 0)
    box = mask.getbbox()
    ink_pixels = sum(mask.histogram()[1:])
    usable = box is not None and maximum - minimum >= 12 and ink_pixels >= 16
    if box:
        usable = usable and min(box[2]-box[0], box[3]-box[1]) >= 4
    output = Image.new("RGB", (224, 224), "white")
    normalization = {"source_size": [64, 64], "source_mode": "L", "source_format": "JPEG",
                     "source_intensity_range": [minimum, maximum], "contrast": "linear_minmax_cutoff_0",
                     "inverted": True, "source_ink_bbox": list(box) if box else None,
                     "source_foreground_pixels": ink_pixels, "foreground_threshold_after_contrast": 20,
                     "preserve_aspect_ratio": True, "padding": 16, "resampling": "Pillow.LANCZOS",
                     "input_kind": "source_raster", "usable": bool(usable), "device_capture": False}
    if box:
        crop = ImageChops.invert(ink).crop(box)
        scale = 192 / max(crop.size)
        size = tuple(max(1, round(value * scale)) for value in crop.size)
        offset = tuple((224-value)//2 for value in size)
        output.paste(crop.resize(size, Image.Resampling.LANCZOS).convert("RGB"), offset)
        normalization.update({"rendered_size": list(size), "offset": list(offset)})
    return output, normalization
