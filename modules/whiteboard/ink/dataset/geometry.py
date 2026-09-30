"""直接生成目标几何；这里的采样和形变只用于制造数据，不是修正教师。"""

from dataclasses import dataclass
import math
import random

Point = tuple[float, float]
Path = list[Point]
FAMILIES = (
    "line", "arc", "ellipse", "rounded_loop", "polyline", "free_curve",
    "wave", "arrow", "frame", "double_line",
)


@dataclass(frozen=True)
class Geometry:
    """完整可见目标；family/primitive 仅用于分层，paths 为共享坐标系下的路径。"""

    family: str
    paths: list[Path]
    primitive: str


def _polyline(vertices: Path, rng: random.Random) -> Path:
    result: Path = []
    for start, end in zip(vertices, vertices[1:]):
        count = rng.randint(7, 15)
        result.extend((start[0] + (end[0] - start[0]) * i / count,
                       start[1] + (end[1] - start[1]) * i / count)
                      for i in range(count))
    return [*result, vertices[-1]]


def _bezier(rng: random.Random) -> Path:
    controls = [(-1.0, rng.uniform(-.5, .5)),
                (rng.uniform(-.9, -.1), rng.uniform(-1.1, 1.1)),
                (rng.uniform(.1, .9), rng.uniform(-1.1, 1.1)),
                (1.0, rng.uniform(-.5, .5))]
    count = rng.randint(35, 65)
    result: Path = []
    for i in range(count):
        t = i / (count - 1)
        weights = ((1 - t) ** 3, 3 * (1 - t) ** 2 * t,
                   3 * (1 - t) * t * t, t ** 3)
        result.append((sum(w * p[0] for w, p in zip(weights, controls)),
                       sum(w * p[1] for w, p in zip(weights, controls))))
    return result


def make_geometry(family: str, rng: random.Random, regular: bool | None = None) -> Geometry:
    """按家族和随机源生成目标；regular 指定圆/正方形，否则随机选取，未知家族报错。"""
    primitive = family
    if regular is None:
        regular = rng.random() < .25
    if family == "line":
        paths = [_polyline([(-1.0, 0.0), (1.0, 0.0)], rng)]
    elif family in ("arc", "ellipse", "rounded_loop"):
        count = rng.randint(40, 70)
        radius_y = 1.0 if family == "ellipse" and regular else rng.uniform(.3, .95)
        if family == "ellipse":
            primitive = "circle" if regular else "ellipse"
        sweep = rng.uniform(.6, 1.7) * math.pi if family == "arc" else math.tau
        phase = rng.uniform(0, math.tau)
        asymmetry = rng.uniform(.04, .18) if family == "rounded_loop" else 0.0
        path = []
        for i in range(count):
            t = phase + sweep * i / (count - 1)
            radial = 1 + asymmetry * math.cos(3 * t + .4)
            path.append((radial * math.cos(t), radius_y * radial * math.sin(t)))
        if family != "arc":
            path[-1] = path[0]
        paths = [path]
    elif family == "polyline":
        count = rng.randint(3, 6)
        vertices = [(-1 + 2 * i / (count - 1), rng.uniform(-.8, .8))
                    for i in range(count)]
        paths = [_polyline(vertices, rng)]
    elif family == "free_curve":
        paths = [_bezier(rng)]
    elif family == "wave":
        cycles, height, phase = rng.uniform(.8, 2.5), rng.uniform(.15, .5), rng.random() * math.tau
        count = rng.randint(55, 80)
        paths = [[(-1 + 2 * i / (count - 1),
                   height * math.sin(phase + math.tau * cycles * i / (count - 1)))
                  for i in range(count)]]
    elif family == "arrow":
        head = rng.uniform(.2, .55)
        paths = [_polyline([(-1.0, 0.0), (1.0, 0.0)], rng),
                 _polyline([(1 - head, -head), (1.0, 0.0), (1 - head, head)], rng)]
    elif family == "frame":
        height = 1.0 if regular else rng.uniform(.3, .9)
        primitive = "square" if regular else "rectangle"
        vertices = [(-1.0, -height), (1.0, -height), (1.0, height), (-1.0, height)]
        paths = [_polyline([a, b], rng)
                 for a, b in zip(vertices, [*vertices[1:], vertices[0]])]
    elif family == "double_line":
        gap = rng.uniform(.12, .3)
        paths = [_polyline([(-1.0, y), (1.0, y)], rng) for y in (-gap / 2, gap / 2)]
    else:
        raise ValueError(f"未知目标家族：{family}")
    return Geometry(family, paths, primitive)


def transform(paths: list[Path], angle: float, scale: float, offset: Point) -> list[Path]:
    """对路径统一刚性变换及等比例缩放；输入和目标共用参数，返回新路径。"""
    cosine, sine = math.cos(angle), math.sin(angle)
    return [[(round(scale * (x * cosine - y * sine) + offset[0], 5),
              round(scale * (x * sine + y * cosine) + offset[1], 5))
             for x, y in path] for path in paths]


def perturb(path: Path, kind: str, severity: float, rng: random.Random) -> Path:
    """制造连续几何偏差；severity 为相对局部尺寸的位移尺度，未知类型报错。"""
    if kind not in ("jitter", "drift", "endpoint", "mixed"):
        raise ValueError(f"未知偏差：{kind}")
    width = max(x for x, _ in path) - min(x for x, _ in path)
    height = max(y for _, y in path) - min(y for _, y in path)
    amplitude = max(width, height) * severity
    phases = [rng.uniform(0, math.tau) for _ in range(4)]
    frequencies = [rng.randint(3, 7), rng.randint(3, 7)]
    end = rng.choice((0, 1))
    direction = rng.uniform(0, math.tau)
    distances = [0.0]
    for a, b in zip(path, path[1:]):
        distances.append(distances[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    if distances[-1] == 0:
        raise ValueError("偏差生成要求路径有非零长度")
    result: Path = []
    for i, (x, y) in enumerate(path):
        # 空间弧长参数与绘制时间无关，避免采样疏密替代形状决定偏差。
        t = distances[i] / distances[-1]
        dx = dy = 0.0
        if kind in ("jitter", "mixed"):
            dx += .65 * math.sin(math.tau * frequencies[0] * t + phases[0])
            dy += .65 * math.sin(math.tau * frequencies[1] * t + phases[1])
        if kind in ("drift", "mixed"):
            dx += math.sin(math.pi * t + phases[2])
            dy += math.sin(math.pi * t + phases[3])
        if kind in ("endpoint", "mixed"):
            weight = math.exp(-((t - end) / .14) ** 2)
            dx += weight * math.cos(direction)
            dy += weight * math.sin(direction)
        result.append((x + amplitude * dx, y + amplitude * dy))
    return result
