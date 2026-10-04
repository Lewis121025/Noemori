"""与分类模型共享的静态栅格化约定：等比居中、黑线白底、没有笔画顺序特征。"""

from PIL import Image, ImageDraw

from .schema import validate_paths

IMAGE_SIZE = 224
PADDING = 16
SUPERSAMPLING = 3


def render_image(paths: list[list[list[float]]], stroke_width: int = 3) -> Image.Image:
    """将完整对象等比放入 224 方图并返回 RGB 图；拒绝非法点及线宽，不改变长宽比。"""
    validate_paths(paths)
    if type(stroke_width) is not int or not 1 <= stroke_width <= 6:
        raise ValueError("线宽必须是 1 到 6 的整数")
    points = [point for path in paths for point in path]
    low = [min(point[i] for point in points) for i in (0, 1)]
    high = [max(point[i] for point in points) for i in (0, 1)]
    scale = (IMAGE_SIZE - 2 * PADDING) / max(high[i] - low[i] for i in (0, 1))
    center = [(low[i] + high[i]) / 2 for i in (0, 1)]
    image = Image.new("L", (IMAGE_SIZE * SUPERSAMPLING,) * 2, 255)
    draw = ImageDraw.Draw(image)
    width = stroke_width * SUPERSAMPLING
    # 统一方向和排序让等价静态图形逐像素一致，不让抗锯齿差异泄露绘制顺序。
    canonical = sorted(min(tuple(map(tuple, path)), tuple(reversed(tuple(map(tuple, path))))) for path in paths)
    for path in canonical:
        pixels = [tuple(round(((point[i] - center[i]) * scale + IMAGE_SIZE / 2) * SUPERSAMPLING)
                        for i in (0, 1)) for point in path]
        if len(pixels) > 1:
            draw.line(pixels, fill=0, width=width, joint="curve")
        for x, y in (pixels[0], pixels[-1]):
            radius = width / 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=0)
    return image.resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.LANCZOS).convert("RGB")
