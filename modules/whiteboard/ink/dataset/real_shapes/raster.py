"""把原70px手绘栅格等比放入分类画布；保留原始分辨率信息，不矢量化。"""

import io

from PIL import Image, ImageChops


def normalize_image(data: bytes) -> tuple[Image.Image, dict]:
    """返回224RGB白底黑墨图和变换记录；只接受70×70合法PNG，空白图仍保留但标记empty。"""
    if len(data) > 1_000_000:
        raise ValueError("原PNG超过大小预算")
    with Image.open(io.BytesIO(data)) as source:
        if source.format != "PNG" or source.size != (70, 70):
            raise ValueError("HDS原图必须为70×70 PNG")
        source.load()
        rgba = source.convert("RGBA")
        canvas = Image.new("RGBA", source.size, "white")
        canvas.alpha_composite(rgba)
        gray = canvas.convert("L")
        source_mode = source.mode
    mask = ImageChops.invert(gray).point(lambda value: 255 if value >= 5 else 0)
    box = mask.getbbox()
    output = Image.new("RGB", (224, 224), "white")
    info = {"source_size": [70, 70], "source_mode": source_mode, "source_ink_bbox": list(box) if box else None,
            "padding": 16, "resampling": "Pillow.LANCZOS", "preserve_aspect_ratio": True,
            "input_kind": "source_raster", "empty": box is None}
    if box is None:
        info.update({"rendered_size": [0, 0], "offset": [112, 112]})
        return output, info
    crop = gray.crop(box)
    scale = 192 / max(crop.size)
    size = tuple(max(1, round(value * scale)) for value in crop.size)
    offset = [(224 - size[i]) // 2 for i in (0, 1)]
    output.paste(crop.resize(size, Image.Resampling.LANCZOS).convert("RGB"), tuple(offset))
    info.update({"rendered_size": list(size), "offset": offset})
    return output, info
