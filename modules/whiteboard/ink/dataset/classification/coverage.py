"""预先定义的基础几何覆盖协议；类别来自明确参数，不从模型预测选择样本。"""

from dataclasses import dataclass
import math
import random
from typing import Iterator

from .schema import Sample, content_hash, split_for_group, validate_sample

COVERAGE_VERSION = "clean-coverage-v1"
POLYGON_MODES = ("closed", "edge_middle", "separate_edges")
EDGE_STEPS = 24


@dataclass(frozen=True)
class GeometrySpec:
    """明确类别、几何参数和朝向的母图；name 只用于审计，不参与来源组划分。"""

    name: str
    label: str
    parameters: dict[str, float]
    rotation_degrees: float

    def contract(self) -> dict:
        """返回可散列几何契约；相同参数即使名字不同，也必须属于相同母图来源组。"""
        return {"label": self.label, "parameters": {key: float(value) for key, value in self.parameters.items()},
                "rotation_degrees": float(self.rotation_degrees)}


def coverage_specs() -> Iterator[GeometrySpec]:
    """输出固定训练补充网格，重点填补0.9至1.0高宽比；不查询预测或已有测试结果。"""
    for ratio in (1.0, 1.01, 1.02, 1.03, 1.05, 1.07, 1.1, 1.25, 1.5, 2.0):
        for angle in (0, 10, 25, 40, 55, 70, 85):
            yield GeometrySpec(f"rectangle-ratio-{ratio}-angle-{angle}", "rectangle",
                               {"width": 240, "height": 240 / ratio}, angle)
    angles = (0, 13, 27, 44, 68, 90, 121, 157)
    for index, angle in enumerate(angles):
        yield GeometrySpec(f"line-{index}", "line", {"length": 240}, angle)
        yield GeometrySpec(f"circle-{index}", "circle", {"radius": 100, "phase_degrees": index * 7}, 0)
        yield GeometrySpec(f"ellipse-{index}", "ellipse", {"rx": 120, "ry": 42 + index * 7}, angle)
        yield GeometrySpec(f"arc-{index}", "arc", {"radius": 110, "sweep_degrees": 65 + index * 29}, angle)
        yield GeometrySpec(f"triangle-{index}", "triangle", {"base": 240, "height": 160 + index * 11,
                                                            "apex_offset": (-35, 0, 35)[index % 3]}, angle)
        yield GeometrySpec(f"arrow-{index}", "arrow", {"length": 240, "head_length": 45 + index * 7,
                                                       "head_half_width": 32 + index * 3}, angle)
    # 原椭圆只到0.8附近，边界段需明确参数监督；不根据保留诊断的预测挑选角度。
    for ratio in (.82, .86, .88, .90, .92, .94, .96):
        for angle in (7, 19, 33, 51, 76, 103, 129, 167):
            yield GeometrySpec(f"ellipse-boundary-{ratio}-angle-{angle}", "ellipse",
                               {"rx": 120, "ry": 120 * ratio}, angle)


def diagnostic_specs() -> Iterator[GeometrySpec]:
    """输出独立且固定的七类接入诊断参数，包含标准方形；诊断对象永不作为训练补充。"""
    rectangle_cases = (("standard-square", 240, 240, 0), ("near-square-250x240", 250, 240, 0),
                       ("wide-rectangle-200x100", 200, 100, 0), ("rotated-rectangle", 210, 145, 23))
    for name, width, height, angle in rectangle_cases:
        yield GeometrySpec(name, "rectangle", {"width": width, "height": height}, angle)
    for index, angle in enumerate((0, 90, 23, -37)):
        yield GeometrySpec(f"diagnostic-line-{index}", "line", {"length": 250 + index * 17}, angle)
        yield GeometrySpec(f"diagnostic-circle-{index}", "circle", {"radius": 94 + index * 13,
                                                                    "phase_degrees": index * 11 + 3}, 0)
        yield GeometrySpec(f"diagnostic-ellipse-{index}", "ellipse", {"rx": 125, "ry": (62, 81, 100, 115)[index]}, angle)
        yield GeometrySpec(f"diagnostic-arc-{index}", "arc", {"radius": 115, "sweep_degrees": (90, 180, 234, 306)[index]}, angle)
        yield GeometrySpec(f"diagnostic-triangle-{index}", "triangle", {"base": 250, "height": 187 + index * 13,
                                                                       "apex_offset": (-50, 0, 55, -15)[index]}, angle)
        yield GeometrySpec(f"diagnostic-arrow-{index}", "arrow", {"length": 250, "head_length": 52 + index * 19,
                                                                  "head_half_width": 41 + index * 7}, angle)


def representations(spec: GeometrySpec) -> tuple[str, ...]:
    """矩形覆盖三种等价笔画表示；其他类别保留天然表示，不制造图形语义差异。"""
    return POLYGON_MODES if spec.label == "rectangle" else ("native",)


def _segment(start, end):
    return [[start[0] + (end[0] - start[0]) * i / EDGE_STEPS,
             start[1] + (end[1] - start[1]) * i / EDGE_STEPS] for i in range(EDGE_STEPS + 1)]


def _polygon(vertices, representation):
    edges = [_segment(a, b) for a, b in zip(vertices, [*vertices[1:], vertices[0]])]
    if representation == "separate_edges":
        return edges
    points = [point for edge in edges for point in edge[:-1]]
    if representation == "edge_middle":
        offset = EDGE_STEPS // 2
        points = points[offset:] + points[:offset]
    elif representation not in ("closed", "native"):
        raise ValueError("未知多边形表示方式")
    return [[*points, points[0]]]


def make_paths(spec: GeometrySpec, representation: str) -> list[list[list[float]]]:
    """按参数构造完整干净路径并旋转；非法尺寸、未知类别/表示抛 ValueError，不依赖笔画时序。"""
    p = spec.parameters
    if (not all(type(value) in (float, int) and math.isfinite(value) for value in p.values())
            or not math.isfinite(spec.rotation_degrees)):
        raise ValueError("参数必须为有限数值")
    for name, value in p.items():
        if name not in ("apex_offset", "phase_degrees") and value <= 0:
            raise ValueError("长度及扫掠角必须为正")
    if spec.label == "rectangle":
        w, h = p["width"] / 2, p["height"] / 2
        paths = _polygon([[-w, -h], [w, -h], [w, h], [-w, h]], representation)
    elif representation != "native":
        raise ValueError("非矩形使用 native 表示")
    elif spec.label == "line":
        paths = [_segment([-p["length"] / 2, 0], [p["length"] / 2, 0])]
    elif spec.label in ("circle", "ellipse", "arc"):
        rx = p["radius"] if spec.label != "ellipse" else p["rx"]
        ry = p["radius"] if spec.label != "ellipse" else p["ry"]
        phase = math.radians(p.get("phase_degrees", 0))
        sweep = math.radians(p["sweep_degrees"]) if spec.label == "arc" else math.tau
        path = [[rx * math.cos(phase + sweep * i / 160), ry * math.sin(phase + sweep * i / 160)] for i in range(161)]
        if spec.label != "arc":
            path[-1] = path[0]
        paths = [path]
    elif spec.label == "triangle":
        paths = _polygon([[-p["base"] / 2, p["height"] / 2], [p["base"] / 2, p["height"] / 2],
                          [p["apex_offset"], -p["height"] / 2]], "native")
    elif spec.label == "arrow":
        end = p["length"] / 2
        wing1 = [end - p["head_length"], -p["head_half_width"]]
        wing2 = [end - p["head_length"], p["head_half_width"]]
        paths = [_segment([-end, 0], [end, 0]), _segment(wing1, [end, 0])[:-1] + _segment([end, 0], wing2)]
    else:
        raise ValueError("未知基础图形")
    angle = math.radians(spec.rotation_degrees)
    return [[[round(x * math.cos(angle) - y * math.sin(angle), 8),
              round(x * math.sin(angle) + y * math.cos(angle), 8)] for x, y in path] for path in paths]


def make_sample(spec: GeometrySpec, representation: str, stroke_width: int, variant: int) -> tuple[Sample, dict]:
    """生成一条干净/轻噪声样本及参数记录；所有表示、线宽和噪声共享母图分组，非法参数报错。"""
    if stroke_width not in range(1, 7) or type(stroke_width) is not int or type(variant) is not int or variant not in (0, 1):
        raise ValueError("线宽必须为1至6，变体只能是干净0或轻噪声1")
    contract = spec.contract()
    source_hash = content_hash(contract)
    group = f"{COVERAGE_VERSION}-{source_hash[:24]}"
    paths = make_paths(spec, representation)
    severity = 0 if variant == 0 else .002
    if severity:
        rng = random.Random(source_hash)
        phases = [rng.uniform(0, math.tau) for _ in range(4)]
        points = [point for path in paths for point in path]
        extent = max(max(p[i] for p in points) - min(p[i] for p in points) for i in (0, 1))
        # 位移取决于空间位置，共享端点和闭合接缝始终一致，不让分笔方式改变母图噪声。
        paths = [[[round(x + extent * severity * math.sin(x / extent * 12 + phases[0]) * math.cos(y / extent * 9 + phases[1]), 8),
                   round(y + extent * severity * math.sin(y / extent * 11 + phases[2]) * math.cos(x / extent * 8 + phases[3]), 8)]
                  for x, y in path] for path in paths]
    identifier = content_hash([group, representation, stroke_width, variant])[:32]
    sample: Sample = {"schema_version": 1, "sample_id": identifier, "group_id": group,
                      "split": split_for_group(group), "label": spec.label, "label_status": "synthetic", "paths": paths,
                      "provenance": {"kind": "procedural", "source_id": f"{group}/{representation}/width-{stroke_width}",
                                     "source_sha256": source_hash, "license": "project-generated", "source_label": spec.label,
                                     "recognized": None, "variant": variant}}
    metadata = {"sample_id": identifier, "group_id": group, "case_name": spec.name, **contract,
                "representation": representation, "stroke_width": stroke_width, "noise_severity": severity,
                "geometry_sha256": content_hash(paths), "protocol": COVERAGE_VERSION}
    validate_sample(sample)
    return sample, metadata
