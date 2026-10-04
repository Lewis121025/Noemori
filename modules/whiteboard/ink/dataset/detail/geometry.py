"""七类解析几何母图及连续单笔遍历，参数独立于任何旧诊断或模型预测。"""

import math

from ..classification.schema import content_hash

CLASSES = ("line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow")
CLOSED = frozenset(("circle", "ellipse", "rectangle", "triangle"))
VERSION = "shape-detail-invariance-v1"


def _fraction(index, offset):
    return ((index + 1) * .6180339887498949 + offset) % 1


def parent_specs(per_class: int = 160) -> list[dict]:
    """返回固定解析参数与按母图哈希隔离的80/10/10划分；数量须为10的正倍数。"""
    if type(per_class) is not int or per_class < 10 or per_class % 10:
        raise ValueError("每类母图数量须为10的正倍数")
    result = []
    for label in CLASSES:
        parents = []
        for index in range(per_class):
            parameters = {"label": label, "index": index, "size": round(211.37 + 73 * _fraction(index, .17), 9),
                          "rotation_degrees": round(360 * _fraction(index, .073), 9),
                          "start_phase_radians": round(2 * math.pi * _fraction(index, .319), 10)}
            if label == "ellipse":
                parameters["axis_ratio"] = round(.4 + .4 * _fraction(index, .41), 9)
            elif label == "arc":
                parameters["sweep_degrees"] = round(65 + 210 * _fraction(index, .27), 9)
            elif label == "rectangle":
                parameters["height_width_ratio"] = round(.43 + .56 * _fraction(index, .11), 9)
            elif label == "triangle":
                parameters.update({"height_width_ratio": round(.58 + .41 * _fraction(index, .33), 9),
                                   "apex_offset_relative_width": round(-.27 + .54 * _fraction(index, .83), 9)})
            elif label == "arrow":
                parameters.update({"head_length_relative_size": round(.21 + .13 * _fraction(index, .23), 9),
                                   "head_half_width_relative_size": round(.13 + .11 * _fraction(index, .53), 9)})
            identifier = content_hash([VERSION, "analytic-parent", parameters])[:32]
            parents.append({"parent_id": identifier, "label": label, "parameters": parameters})
        parents.sort(key=lambda p: content_hash(["detail-parent-split-v1", p["parent_id"]]))
        for rank, parent in enumerate(parents):
            parent["assigned_split"] = "train" if rank < per_class * .8 else "val" if rank < per_class * .9 else "test"
        result.extend(parents)
    return result


def _segments(vertices, maximum_step):
    points = [vertices[0]]
    for start, end in zip(vertices, vertices[1:]):
        count = max(1, math.ceil(math.dist(start, end) / maximum_step))
        points.extend([[start[d] + (end[d]-start[d])*i/count for d in (0, 1)] for i in range(1, count+1)])
    return points


def clean_path(parameters: dict) -> list[list[float]]:
    """重建解析母图单笔；箭头沿轴和两翼连续遍历并停在第二翼，圆弧严格开放。"""
    label, size = parameters["label"], parameters["size"]
    if label not in CLASSES or not math.isfinite(size) or size <= 0:
        raise ValueError("母图类别或尺度非法")
    if label in ("circle", "ellipse", "arc"):
        ratio = parameters.get("axis_ratio", 1)
        if label == "ellipse" and not .4 <= ratio <= .8:
            raise ValueError("合成椭圆轴比必须为.40至.80")
        sweep = math.radians(parameters["sweep_degrees"]) if label == "arc" else 2 * math.pi
        if label == "arc" and not 0 < sweep < 2 * math.pi:
            raise ValueError("开放圆弧扫角不能闭合")
        phase = parameters["start_phase_radians"]
        count = max(64, math.ceil(96 * sweep / 2))
        points = [[size/2 * math.cos(phase+sweep*i/count), size*ratio/2 * math.sin(phase+sweep*i/count)] for i in range(count+1)]
        if label in CLOSED:
            points[-1] = points[0].copy()
    else:
        if label == "line":
            vertices = [[-size/2, 0], [size/2, 0]]
        elif label == "rectangle":
            h = size * parameters["height_width_ratio"] / 2
            vertices = [[-size/2, -h], [size/2, -h], [size/2, h], [-size/2, h], [-size/2, -h]]
        elif label == "triangle":
            h = size * parameters["height_width_ratio"]
            vertices = [[-size/2, h/3], [size/2, h/3], [size*parameters["apex_offset_relative_width"], -2*h/3], [-size/2, h/3]]
        else:
            tip = [size/2, 0]
            wing_x = size/2 - size * parameters["head_length_relative_size"]
            wing_y = size * parameters["head_half_width_relative_size"]
            vertices = [[-size/2, 0], tip, [wing_x, -wing_y], tip, [wing_x, wing_y]]
        points = _segments(vertices, size/96)
    angle = math.radians(parameters["rotation_degrees"])
    cosine, sine = math.cos(angle), math.sin(angle)
    result = [[round(x*cosine-y*sine, 9), round(x*sine+y*cosine, 9)] for x, y in points]
    if label in CLOSED:
        result[-1] = result[0].copy()
    return result
