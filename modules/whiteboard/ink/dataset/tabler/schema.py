"""扩展数据的独立来源契约；模型的几何输入与替换目标沿用第一版。"""

import re
from typing import Literal, TypedDict

from ..schema import Annotation, CORRUPTIONS, Input, KeepTarget, ReplaceTarget
from ..schema import _fields, _integer, _mapping, _number, _paths, _string
from .sources import REVISION, source_assignment

GENERATOR_VERSION = "tabler-synthetic-v1.0.0"


class Provenance(TypedDict):
    """记录源文件与同划分上下文；全部属于审计元数据，禁止作为模型特征。"""

    kind: Literal["synthetic"]
    generator_version: str
    source_revision: str
    source_file: str
    source_sha256: str
    source_family: str
    context_source_files: list[str]
    seed: int
    augmentation_index: int
    variant_index: int
    corruption: str
    severity: float


class TablerSample(TypedDict):
    """与原版相同的几何监督接口，外部素材追溯使用独立 provenance 定义。"""

    schema_version: Literal[1]
    sample_id: str
    group_id: str
    input: Input
    target: KeepTarget | ReplaceTarget
    annotation: Annotation
    provenance: Provenance


def validate_sample(value: object) -> None:
    """严格校验样本和来源划分；正确时不返回内容，发现异常抛出 ValueError。"""
    sample = _mapping(value, "sample")
    _fields(sample, {"schema_version", "sample_id", "group_id", "input", "target", "annotation", "provenance"}, "sample")
    if type(sample["schema_version"]) is not int or sample["schema_version"] != 1:
        raise ValueError("未知扩展样本版本")
    _string(sample["sample_id"], "sample_id")
    _string(sample["group_id"], "group_id")
    features = _mapping(sample["input"], "input")
    _fields(features, {"focus_stroke_id", "strokes"}, "input")
    identifiers = _paths(features["strokes"], True, "input.strokes")
    if _string(features["focus_stroke_id"], "focus_stroke_id") not in identifiers:
        raise ValueError("focus 不在输入笔画中")
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
        if len(source_ids) != len(set(source_ids)) or not set(source_ids) <= set(identifiers):
            raise ValueError("替换范围重复或引用缺失")
        _paths(target["strokes"], False, "target.strokes")
    else:
        raise ValueError("未知修正操作")
    if sample["annotation"] != {"status": "generated"}:
        raise ValueError("扩展样本必须标为合成标签")
    provenance = _mapping(sample["provenance"], "provenance")
    _fields(provenance, {"kind", "generator_version", "source_revision", "source_file", "source_sha256", "source_family",
                        "context_source_files", "seed", "augmentation_index", "variant_index", "corruption", "severity"}, "provenance")
    if provenance["kind"] != "synthetic" or provenance["generator_version"] != GENERATOR_VERSION or provenance["source_revision"] != REVISION:
        raise ValueError("扩展素材来源或生成器版本不符")
    filename = _string(provenance["source_file"], "source_file")
    family, split = source_assignment(filename)
    if provenance["source_family"] != family or sample["group_id"] != f"tabler-{family}":
        raise ValueError("来源族或分组错误")
    digest = _string(provenance["source_sha256"], "source_sha256")
    if not re.fullmatch("[0-9a-f]{64}", digest):
        raise ValueError("素材 SHA256 格式不符")
    contexts = provenance["context_source_files"]
    if not isinstance(contexts, list) or not contexts:
        raise ValueError("上下文素材清单缺失")
    for context in contexts:
        if source_assignment(_string(context, "context_source_file"))[1] != split:
            raise ValueError("上下文素材跨划分泄漏")
    for name in ("seed", "augmentation_index", "variant_index"):
        _integer(provenance[name], name)
    if provenance["corruption"] not in CORRUPTIONS:
        raise ValueError("未知偏差")
    severity = _number(provenance["severity"], "severity")
    if not 0 <= severity <= .1 or (severity == 0) != (action == "keep"):
        raise ValueError("偏差尺度与标签不符")
    if (provenance["corruption"] == "keep") != (action == "keep"):
        raise ValueError("偏差类型与标签不符")
