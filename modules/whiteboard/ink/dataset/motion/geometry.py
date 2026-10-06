"""新的解析母图域；旧detail的参数、身份和划分保持不变。"""

import math

from ..classification.schema import LABELS, content_hash
from ..detail.geometry import clean_path as supported_path

VERSION = "shape-motion-invariance-v1"
DOMAIN = "synthetic_motion"
OTHER_FAMILIES = ("pentagon", "trapezoid", "spiral", "wave", "figure_eight")
CLOSED = frozenset(("circle", "ellipse", "rectangle", "triangle"))


def _fractions(label, index):
    digest = content_hash([VERSION, "parameters", label, index])
    return [int(digest[i*4:(i+1)*4], 16) / 65536 for i in range(16)]


def parent_specs(per_class: int = 240) -> list[dict]:
    """返回八类独立母图及固定80/10/10划分；数量须为10的正倍数，否则抛ValueError。"""
    if type(per_class) is not int or per_class < 10 or per_class % 10:
        raise ValueError("motion每类母图数须为10的正倍数")
    parents = []
    for label in LABELS:
        group = []
        for index in range(per_class):
            f = _fractions(label, index)
            parameters = {"label": label, "index": index, "size": round(48.173 + 311.619*f[0], 9),
                          "rotation_degrees": round(360*f[1], 9), "start_phase_radians": round(2*math.pi*f[2], 10)}
            if label == "ellipse":
                parameters["axis_ratio"] = round(.7 + .1*f[3] if index % 5 < 3 else .4 + .3*f[3], 9)
            elif label == "arc":
                parameters["sweep_degrees"] = round(70 + 195*f[3], 9)
            elif label == "rectangle":
                parameters["height_width_ratio"] = round(.49 + .55*f[3], 9)
            elif label == "triangle":
                parameters.update({"height_width_ratio": round(.62 + .5*f[3], 9),
                                   "apex_offset_relative_width": round(-.24 + .48*f[4], 9)})
            elif label == "arrow":
                parameters.update({"head_length_relative_size": round(.23 + .12*f[3], 9),
                                   "head_half_width_relative_size": round(.13 + .105*f[4], 9)})
            elif label == "other":
                parameters.update({"family": OTHER_FAMILIES[index % len(OTHER_FAMILIES)],
                                   "top_width_ratio": round(.3 + .2*f[3], 9), "height_width_ratio": round(.55 + .35*f[4], 9),
                                   "turns": round(2.3 + 1.3*f[5], 9), "wave_cycles": round(2.5 + 1.5*f[6], 9),
                                   "wave_height_relative_size": round(.2 + .1*f[7], 9)})
            identifier = content_hash([VERSION, "independent-parent", parameters])[:32]
            group.append({"parent_id": identifier, "label": label, "parameters": parameters})
        group.sort(key=lambda p: content_hash([VERSION, "parent-split", p["parent_id"]]))
        for rank, parent in enumerate(group):
            parent["assigned_split"] = "train" if rank < per_class*.8 else "val" if rank < per_class*.9 else "test"
        parents.extend(group)
    return parents


def _polygon(vertices):
    points = [vertices[0]]
    for start, end in zip(vertices, vertices[1:]):
        steps = max(1, math.ceil(math.dist(start, end)*120))
        points.extend([[start[d] + (end[d]-start[d])*i/steps for d in (0, 1)] for i in range(1, steps+1)])
    return points


def clean_path(parameters: dict) -> list:
    """重建目标轮廓；other仅为明确不支持的形状，不以完整回圈或折返充当负例。"""
    if parameters["label"] != "other":
        return supported_path(parameters)
    size, family = parameters["size"], parameters["family"]
    if not math.isfinite(size) or size <= 0 or family not in OTHER_FAMILIES:
        raise ValueError("motion other母图参数非法")
    if family == "pentagon":
        vertices = [[.5*math.cos(2*math.pi*i/5), .5*math.sin(2*math.pi*i/5)] for i in range(5)]
        points = _polygon(vertices + [vertices[0]])
    elif family == "trapezoid":
        top, height = parameters["top_width_ratio"]/2, parameters["height_width_ratio"]/2
        points = _polygon([[-.5, height], [.5, height], [top, -height], [-top, -height], [-.5, height]])
    elif family == "spiral":
        points = [[(.06 + .44*i/480)*math.cos(2*math.pi*parameters["turns"]*i/480),
                   (.06 + .44*i/480)*math.sin(2*math.pi*parameters["turns"]*i/480)] for i in range(481)]
    elif family == "wave":
        points = [[i/480-.5, parameters["wave_height_relative_size"]*math.sin(2*math.pi*parameters["wave_cycles"]*i/480)] for i in range(481)]
    else:
        points = [[.5*math.sin(2*math.pi*i/480), .3*math.sin(4*math.pi*i/480)] for i in range(481)]
        points[-1] = points[0].copy()
    angle = math.radians(parameters["rotation_degrees"])
    cosine, sine = math.cos(angle), math.sin(angle)
    return [[round(size*(x*cosine-y*sine), 9), round(size*(x*sine+y*cosine), 9)] for x, y in points]
