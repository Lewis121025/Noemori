"""几何样本的严格边界契约；未知字段也拒绝，防止动作特征和答案混入输入。"""

import math
from typing import Literal, TypedDict

from .geometry import FAMILIES

GENERATOR_VERSION = "geometry-v1.0.0"
CORRUPTIONS = ("keep", "jitter", "drift", "endpoint", "mixed", "retrace", "fragment")


class Stroke(TypedDict):
    """输入笔画；id 仅引用本样本，points 的排列只表示路径连接关系。"""

    id: str
    points: list[list[float]]


class TargetStroke(TypedDict):
    """认可的目标路径；点数及笔画数量允许改变，不假造绘制时间或压力。"""

    points: list[list[float]]


class Input(TypedDict):
    """推理时唯一可用的特征；focus 指向本次新增的完整可见笔画。"""

    focus_stroke_id: str
    strokes: list[Stroke]


class KeepTarget(TypedDict):
    """保持原样标签；不携带替换范围或路径。"""

    action: Literal["keep"]


class ReplaceTarget(TypedDict):
    """替换标签；范围可只涉及相关旧笔画，范围外的输入笔画按原值保留。"""

    action: Literal["replace"]
    source_stroke_ids: list[str]
    strokes: list[TargetStroke]


class Provenance(TypedDict):
    """仅用于追溯和分层分析的合成信息；不得作为模型特征。"""

    kind: Literal["synthetic"]
    generator_version: str
    seed: int
    group_index: int
    variant_index: int
    family: str
    primitive: str
    corruption: str
    severity: float


class Annotation(TypedDict):
    """合成标签身份；不冒充人工认可或真实用户偏差。"""

    status: Literal["generated"]


class Sample(TypedDict):
    """几何修正配对；input 为特征，其余字段均为监督或数据管理信息。"""

    schema_version: Literal[1]
    sample_id: str
    group_id: str
    input: Input
    target: KeepTarget | ReplaceTarget
    annotation: Annotation
    provenance: Provenance


def _mapping(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{name} 必须是字符串键对象")
    return {key: item for key, item in value.items()}


def _fields(value: dict[str, object], expected: set[str], name: str) -> None:
    if set(value) != expected:
        raise ValueError(f"{name} 字段不符：缺少 {expected - set(value)}，多出 {set(value) - expected}")


def _string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError(f"{name} 必须是非空短字符串")
    return value


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} 必须是有限数")
    try:
        number = float(value)
    except OverflowError as error:
        raise ValueError(f"{name} 超出浮点数范围") from error
    if not math.isfinite(number):
        raise ValueError(f"{name} 必须是有限数")
    return number


def _integer(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} 必须是非负整数")
    return value


def _paths(value: object, with_ids: bool, name: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 128:
        raise ValueError(f"{name} 必须包含 1 到 128 条路径")
    identifiers: list[str] = []
    total = 0
    for index, raw in enumerate(value):
        stroke = _mapping(raw, f"{name}[{index}]")
        _fields(stroke, {"id", "points"} if with_ids else {"points"}, name)
        if with_ids:
            identifiers.append(_string(stroke["id"], "stroke.id"))
        points = stroke["points"]
        if not isinstance(points, list) or not 1 <= len(points) <= 8192:
            raise ValueError("路径必须包含 1 到 8192 个点")
        total += len(points)
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("点只能包含 x、y 两个坐标")
            for coordinate in point:
                _number(coordinate, "坐标")
    if total > 65536:
        raise ValueError("单个样本路径点过多")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("输入笔画 ID 重复")
    return identifiers


def validate_sample(value: object) -> None:
    """校验单个 JSON 样本且不修改它；合法时返回 None，契约不符抛出 ValueError。"""
    sample = _mapping(value, "sample")
    _fields(sample, {"schema_version", "sample_id", "group_id", "input", "target",
                     "annotation", "provenance"}, "sample")
    if type(sample["schema_version"]) is not int or sample["schema_version"] != 1:
        raise ValueError("未知样本版本")
    _string(sample["sample_id"], "sample_id")
    _string(sample["group_id"], "group_id")
    features = _mapping(sample["input"], "input")
    _fields(features, {"focus_stroke_id", "strokes"}, "input")
    identifiers = _paths(features["strokes"], True, "input.strokes")
    focus = _string(features["focus_stroke_id"], "focus_stroke_id")
    if focus not in identifiers:
        raise ValueError("focus 必须引用输入笔画")
    target = _mapping(sample["target"], "target")
    action = target.get("action")
    if action == "keep":
        _fields(target, {"action"}, "target")
    elif action == "replace":
        _fields(target, {"action", "source_stroke_ids", "strokes"}, "target")
        sources = target["source_stroke_ids"]
        if not isinstance(sources, list) or not sources:
            raise ValueError("替换范围不能为空")
        source_ids = [_string(item, "source_stroke_id") for item in sources]
        if len(set(source_ids)) != len(source_ids) or not set(source_ids) <= set(identifiers):
            raise ValueError("替换范围引用缺失或重复的笔画")
        _paths(target["strokes"], False, "target.strokes")
    else:
        raise ValueError("未知修正操作")
    annotation = _mapping(sample["annotation"], "annotation")
    _fields(annotation, {"status"}, "annotation")
    if annotation["status"] != "generated":
        raise ValueError("本版本只接受明确标记的合成标签")
    provenance = _mapping(sample["provenance"], "provenance")
    _fields(provenance, {"kind", "generator_version", "seed", "group_index", "variant_index",
                        "family", "primitive", "corruption", "severity"}, "provenance")
    if provenance["kind"] != "synthetic" or provenance["generator_version"] != GENERATOR_VERSION:
        raise ValueError("合成来源或生成器版本不符")
    for field in ("seed", "group_index", "variant_index"):
        _integer(provenance[field], field)
    if provenance["family"] not in FAMILIES or provenance["corruption"] not in CORRUPTIONS:
        raise ValueError("未知目标家族或偏差")
    family = _string(provenance["family"], "family")
    primitives = {"ellipse": ("circle", "ellipse"), "frame": ("square", "rectangle")}
    if provenance["primitive"] not in primitives.get(family, (family,)):
        raise ValueError("目标子型与家族不一致")
    severity = _number(provenance["severity"], "severity")
    if not 0 <= severity <= .1:
        raise ValueError("偏差强度超出首版范围")
    is_keep = provenance["corruption"] == "keep"
    if is_keep != (action == "keep") or is_keep != (severity == 0):
        raise ValueError("修正标签与偏差元数据冲突")
