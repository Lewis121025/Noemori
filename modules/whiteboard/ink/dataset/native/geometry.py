"""原生 SVG 命令、解析和形状归一化；绝不以采样点替代曲线或圆弧。"""

import math
from io import StringIO
from typing import TypedDict

from svgelements import (
    SVG,
    Arc,
    Close,
    CubicBezier,
    Line,
    Move,
    QuadraticBezier,
)
from svgelements import (
    Path as SVGPath,
)
from svgelements import (
    Shape as SVGShape,
)

from ..tabler.svg import _audit

ARITY = {"M": 2, "L": 2, "Q": 4, "C": 6, "A": 7, "Z": 0}


class Command(TypedDict):
    """绝对 SVG 命令；A 的参数顺序为 rx、ry、角度、大弧标志、扫掠标志、终点 x/y。"""

    op: str
    args: list[float]


class NativePath(TypedDict):
    """一个子路径，必须以 M 开始；闭合由 Z 明确表达，不包含离散轮廓点。"""

    commands: list[Command]


class Shape(TypedDict):
    """共享坐标系下的原生子路径集合；只包含几何，无分类、样式或原画布信息。"""

    paths: list[NativePath]


def validate_shape(shape: Shape) -> None:
    """检查原生字段、参数、路径语法；旧点列、非有限数、非法半径/标志或空路径抛 ValueError。"""
    if (
        not isinstance(shape, dict)
        or set(shape) != {"paths"}
        or not isinstance(shape["paths"], list)
        or not shape["paths"]
    ):
        raise ValueError("原生几何必须只含非空 paths")
    for path in shape["paths"]:
        if (
            not isinstance(path, dict)
            or set(path) != {"commands"}
            or not isinstance(path["commands"], list)
        ):
            raise ValueError("路径必须保留 commands，禁止使用采样 points")
        commands = path["commands"]
        if len(commands) < 2 or not any(
            c.get("op") in ("L", "Q", "C", "A") for c in commands if isinstance(c, dict)
        ):
            raise ValueError("子路径必须包含可绘制几何元素")
        for i, c in enumerate(commands):
            if (
                not isinstance(c, dict)
                or set(c) != {"op", "args"}
                or c["op"] not in ARITY
            ):
                raise ValueError("未知原生命令或字段")
            op, args = c["op"], c["args"]
            if (
                not isinstance(args, list)
                or len(args) != ARITY[op]
                or any(
                    type(v) not in (int, float) or not math.isfinite(v) for v in args
                )
            ):
                raise ValueError("命令参数数量或数值不合法")
            if (
                (i == 0 and op != "M")
                or (i > 0 and op == "M")
                or (op == "Z" and i != len(commands) - 1)
            ):
                raise ValueError("子路径起点或闭合位置错误")
            if op == "A" and (
                min(args[:2]) <= 0 or args[3] not in (0, 1) or args[4] not in (0, 1)
            ):
                raise ValueError("圆弧半径必须为正，标志必须为 0/1")


def path_data(path: NativePath) -> str:
    """返回可直接渲染的绝对 SVG d 字符串；不量化、不采样，非法命令抛 ValueError。"""
    validate_shape({"paths": [path]})
    return " ".join(
        c["op"]
        + (
            " " + " ".join(format(float(v), ".17g") for v in c["args"])
            if c["args"]
            else ""
        )
        for c in path["commands"]
    )


def _xy(point):
    return [float(point.x), float(point.y)]


def _from_path(path: SVGPath) -> list[NativePath]:
    result = []
    for subpath in path.as_subpaths():
        commands = []
        for segment in subpath:
            if isinstance(segment, Move):
                op, args = "M", _xy(segment.end)
            elif isinstance(segment, Close):
                op, args = "Z", []
            elif isinstance(segment, Line):
                op, args = "L", _xy(segment.end)
            elif isinstance(segment, QuadraticBezier):
                op, args = "Q", _xy(segment.control) + _xy(segment.end)
            elif isinstance(segment, CubicBezier):
                op, args = (
                    "C",
                    _xy(segment.control1) + _xy(segment.control2) + _xy(segment.end),
                )
            elif isinstance(segment, Arc):
                rx, ry = float(segment.rx), float(segment.ry)
                a, b = segment.prx - segment.center, segment.pry - segment.center
                if abs(a.x * b.x + a.y * b.y) > 1e-8 * rx * ry:
                    raise ValueError(
                        "暂不支持把剪切后的非正交椭圆轴直接导出为 A；禁止采样降级"
                    )
                angle = (float(segment.get_rotation().as_degrees) + 180) % 360 - 180
                op, args = (
                    "A",
                    [
                        rx,
                        ry,
                        angle,
                        int(abs(segment.sweep) > math.pi + 1e-10),
                        int(segment.sweep > 0),
                        *_xy(segment.end),
                    ],
                )
            else:
                # 段对象由 SVG 解析器创建；不支持的命令属于输入内容错误。
                raise ValueError(f"不支持的原生段：{type(segment).__name__}")  # noqa: TRY004
            commands.append({"op": op, "args": args})
        result.append({"commands": commands})
    return result


def parse_path(data: str) -> Shape:
    """解析 SVG d 并展开相对/简写命令，保留 Q/C/A 参数；非法或空几何抛 ValueError。"""
    shape = {"paths": _from_path(SVGPath(data))}
    validate_shape(shape)
    return shape


def parse_svg(xml: str) -> Shape:
    """严格导入描边 SVG 并保留原生曲线；不支持的图元、填充或变换显式报错，不采样降级。"""
    expected = _audit(xml)
    document = SVG.parse(
        StringIO(xml), reify=True, parse_display_none=True, on_error="raise"
    )
    shapes = [
        element for element in document.elements() if isinstance(element, SVGShape)
    ]
    if len(shapes) != expected:
        raise ValueError("SVG 图元计数不符")
    paths = []
    for shape in shapes:
        values = shape.values
        fill = shape.fill.value is not None and shape.fill.opacity != 0
        stroke = (
            shape.stroke.value is not None
            and shape.stroke.opacity != 0
            and float(shape.stroke_width) > 0
        )
        if (
            values.get("display") == "none"
            or values.get("visibility") in ("hidden", "collapse")
            or float(values.get("opacity", 1)) == 0
            or not (fill or stroke)
        ):
            continue
        if fill:
            raise ValueError("本数据只表示描边几何，不把填充图元当成线稿")
        if any(float(values.get(key, 1)) != 1 for key in ("opacity", "stroke-opacity")):
            raise ValueError("不支持半透明描边")
        path = SVGPath(shape)
        path.reify()
        paths.extend(_from_path(path))
    result = {"paths": paths}
    validate_shape(result)
    return result


def bounds(shape: Shape) -> tuple[float, float, float, float]:
    """根据直线、曲线极值和圆弧计算几何包围盒；不是控制点包围盒，退化或非有限边界抛 ValueError。"""
    validate_shape(shape)
    boxes = [SVGPath(path_data(p)).bbox() for p in shape["paths"]]
    if any(box is None for box in boxes):
        raise ValueError("无法取得原生几何边界")
    result = (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )
    result = tuple(float(v) for v in result)
    if (
        not all(math.isfinite(v) for v in result)
        or max(result[2] - result[0], result[3] - result[1]) <= 0
    ):
        raise ValueError("图形没有正有限跨度")
    return result


def transform(
    shape: Shape,
    *,
    scale: float = 1.0,
    offset: tuple[float, float] = (0.0, 0.0),
    angle: float = 0.0,
) -> Shape:
    """统一旋转（弧度）、正等比缩放和平移，返回新图形；保留控制点/半径/弧方向，非法参数抛 ValueError。"""
    validate_shape(shape)
    if not all(math.isfinite(v) for v in (scale, *offset, angle)) or scale <= 0:
        raise ValueError("变换参数非法")
    cosine, sine = math.cos(angle), math.sin(angle)
    result = {"paths": []}
    for path in shape["paths"]:
        commands = []
        for c in path["commands"]:
            op, args = c["op"], c["args"][:]
            first = 5 if op == "A" else 0
            for i in range(first, len(args), 2):
                x, y = args[i : i + 2]
                args[i : i + 2] = [
                    scale * (cosine * x - sine * y) + offset[0],
                    scale * (sine * x + cosine * y) + offset[1],
                ]
            if op == "A":
                args[:3] = [
                    args[0] * scale,
                    args[1] * scale,
                    (args[2] + math.degrees(angle) + 180) % 360 - 180,
                ]
            commands.append({"op": op, "args": args})
        result["paths"].append({"commands": commands})
    return result


def normalize_pair(source: Shape, target: Shape) -> tuple[dict, dict]:
    """按输入曲线包围盒归一化配对并返回逆变换所需的中心和尺度；非法或退化几何抛 ValueError。"""
    low_x, low_y, high_x, high_y = bounds(source)
    center = ((low_x + high_x) / 2, (low_y + high_y) / 2)
    scale = max(high_x - low_x, high_y - low_y)
    kwargs = {"scale": 1 / scale, "offset": (-center[0] / scale, -center[1] / scale)}
    pair = {"input": transform(source, **kwargs), "target": transform(target, **kwargs)}
    return pair, {"center": list(center), "scale": scale}
