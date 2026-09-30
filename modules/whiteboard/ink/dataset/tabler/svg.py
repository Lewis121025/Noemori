"""通过 svgelements 严格导入描边几何；不支持的 SVG 行为必须显式失败。"""

from dataclasses import dataclass
from io import StringIO
import math
from pathlib import Path as FilePath
import xml.etree.ElementTree as ET

from svgelements import Arc, Close, CubicBezier, Line, Move, Path, Point as SVGPoint, QuadraticBezier, Shape, Subpath, SVG

from ..geometry import Path as GeometryPath, Point

CURVE_TOLERANCE = .015
MAX_SEGMENT_LENGTH = .6
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
_COMMON = {"id", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
           "stroke-opacity", "fill-opacity", "opacity", "transform", "display", "visibility"}
_ATTRIBUTES = {
    "svg": {"width", "height", "viewBox", "preserveAspectRatio"}, "g": set(), "path": {"d"},
    "line": {"x1", "y1", "x2", "y2"}, "polyline": {"points"}, "polygon": {"points"},
    "rect": {"x", "y", "width", "height", "rx", "ry"}, "circle": {"cx", "cy", "r"},
    "ellipse": {"cx", "cy", "rx", "ry"},
}


@dataclass(frozen=True)
class ImportedGeometry:
    """导入结果；paths 保留各子路径边界，excluded 逐项说明未形成可见描边的原因。"""

    paths: list[GeometryPath]
    shape_count: int
    excluded: list[dict[str, object]]


def _audit(xml: str) -> int:
    if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise ValueError("不支持 DTD 或实体声明")
    root = ET.fromstring(xml)
    if root.tag != f"{{{SVG_NAMESPACE}}}svg":
        raise ValueError("根元素必须是 SVG 命名空间下的 svg")
    shapes = 0
    for node in root.iter():
        if not node.tag.startswith(f"{{{SVG_NAMESPACE}}}"):
            raise ValueError(f"不支持外部命名空间：{node.tag}")
        tag = node.tag.split("}", 1)[1]
        if tag not in _ATTRIBUTES:
            raise ValueError(f"不支持的 SVG 元素：{tag}")
        unknown = set(node.attrib) - _ATTRIBUTES[tag] - _COMMON
        if unknown:
            raise ValueError(f"不支持 {tag} 属性：{sorted(unknown)}")
        if tag == "svg" and node is not root:
            raise ValueError("不支持嵌套视口，禁止遗漏裁剪语义")
        if tag not in ("svg", "g"):
            shapes += 1
    return shapes


def _point(value: SVGPoint | None) -> Point:
    if value is None:
        raise ValueError("路径段缺少坐标")
    point = (float(value.x), float(value.y))
    if not all(math.isfinite(coordinate) for coordinate in point):
        raise ValueError("SVG 产生非有限坐标")
    return point


def _distance_to_chord(point: Point, start: Point, end: Point) -> float:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.dist(point, start)
    ratio = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared))
    return math.dist(point, (start[0] + ratio * dx, start[1] + ratio * dy))


def _flatten_segment(segment: Line | Close | Arc | CubicBezier | QuadraticBezier) -> GeometryPath:
    start, end = _point(segment.start), _point(segment.end)
    result = [start]

    def visit(t0: float, t1: float, a: Point, b: Point, depth: int) -> None:
        probes = [_point(segment.point(t0 + (t1 - t0) * fraction)) for fraction in (.25, .5, .75)]
        error = max(_distance_to_chord(point, a, b) for point in probes)
        if error <= CURVE_TOLERANCE and math.dist(a, b) <= MAX_SEGMENT_LENGTH:
            if b != result[-1]:
                result.append(b)
            return
        if depth >= 18:
            raise ValueError("曲线离散达到递归上限，拒绝降低精度后继续")
        middle = (t0 + t1) / 2
        visit(t0, middle, a, probes[1], depth + 1)
        visit(middle, t1, probes[1], b, depth + 1)

    visit(0.0, 1.0, start, end, 0)
    return result


def _sample_subpath(subpath: Subpath) -> GeometryPath:
    points: GeometryPath = []
    for segment in subpath:
        if isinstance(segment, Move):
            if points:
                raise ValueError("子路径中出现未拆分的 Move")
            points.append(_point(segment.end))
            continue
        if not isinstance(segment, (Line, Close, Arc, CubicBezier, QuadraticBezier)):
            raise ValueError(f"未知路径段：{type(segment).__name__}")
        sampled = _flatten_segment(segment)
        if points and math.dist(points[-1], sampled[0]) > 1e-8:
            raise ValueError("子路径存在不连续连接")
        points.extend(sampled[1:] if points else sampled)
    if len(points) < 2 or sum(math.dist(a, b) for a, b in zip(points, points[1:])) == 0:
        raise ValueError("可见描边只有孤立点或零长度，本版尚不支持")
    # 给短线保留足够采样点，供相同的合并/扰动契约使用；所有原角点仍被保留。
    while len(points) < 7:
        points = [point for a, b in zip(points, points[1:])
                  for point in (a, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))] + [points[-1]]
    return points


def parse_svg_text(xml: str) -> ImportedGeometry:
    """解析受支持的 SVG 描边并离散曲线；返回路径与排除记录，未知/填充语义抛 ValueError。"""
    expected = _audit(xml)
    document = SVG.parse(StringIO(xml), reify=True, parse_display_none=True, on_error="raise")
    shapes = [element for element in document.elements() if isinstance(element, Shape)]
    if len(shapes) != expected:
        raise ValueError("SVG 库解析的图元数与原文不符，存在潜在遗漏")
    paths: list[GeometryPath] = []
    excluded: list[dict[str, object]] = []
    for index, shape in enumerate(shapes):
        values = shape.values
        hidden = values.get("display") == "none" or values.get("visibility") in ("hidden", "collapse")
        invisible = float(values.get("opacity", 1)) == 0
        fill_visible = shape.fill.value is not None and shape.fill.opacity != 0
        stroke_visible = (shape.stroke.value is not None and shape.stroke.opacity != 0
                          and float(shape.stroke_width) > 0)
        if hidden or invisible or not (fill_visible or stroke_visible):
            excluded.append({"shape_index": index, "reason": "无可见填充和描边，或明确隐藏"})
            continue
        if fill_visible:
            raise ValueError("存在填充图元；本版只导入描边中心线，不能默默当成线稿")
        if any(float(values.get(name, 1)) != 1 for name in ("opacity", "stroke-opacity")):
            raise ValueError("不支持半透明描边")
        path = Path(shape)
        for subpath in path.as_subpaths():
            paths.append(_sample_subpath(subpath))
    if not paths:
        raise ValueError("没有可导入的描边几何")
    return ImportedGeometry(paths, len(shapes), excluded)


def parse_svg_file(path: FilePath) -> ImportedGeometry:
    """读取并严格解析 SVG 文件；I/O、XML 格式和几何错误原样传播，不跳过失败素材。"""
    return parse_svg_text(path.read_text(encoding="utf-8"))
