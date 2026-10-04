"""分类样本契约：标签及来源只供监督与审计，不进入模型图像。"""

import hashlib
import json
import math
import re
from typing import TypedDict

LABELS = ("line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow", "other")
SPLITS = ("train", "val", "test", "review")
VERSION = "shape-classification-v1"


class Provenance(TypedDict):
    """记录原始对象、内容散列和许可；recognized 仅是 QuickDraw 游戏的历史判断。"""

    kind: str
    source_id: str
    source_sha256: str
    license: str
    source_label: str
    recognized: bool | None
    variant: int


class Sample(TypedDict):
    """一个完整待识别对象；paths 不含时间，未复核提示标签仅允许进入 review。"""

    schema_version: int
    sample_id: str
    group_id: str
    split: str
    label: str
    label_status: str
    paths: list[list[list[float]]]
    provenance: Provenance


def content_hash(value: object) -> str:
    """返回规范 JSON 的 SHA-256；非有限数或不可序列化值由 JSON 编码器报错。"""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def split_for_group(group_id: str) -> str:
    """根据原始来源组稳定划分 80/10/10；增加样本或增强次数不会迁移旧组。"""
    bucket = int(hashlib.sha256((VERSION + "|" + group_id).encode()).hexdigest()[:16], 16) % 100
    return "train" if bucket < 80 else "val" if bucket < 90 else "test"


def validate_paths(paths: list[list[list[float]]]) -> None:
    """检查有限二维坐标与非退化整体范围，保留点笔画；空输入或非法数据抛 ValueError。"""
    if not isinstance(paths, list) or not paths:
        raise ValueError("paths 必须是非空路径列表")
    flat = []
    for path in paths:
        if not isinstance(path, list) or not path:
            raise ValueError("路径不能为空")
        for point in path:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("每个点必须只有 x/y")
            for value in point:
                try:
                    finite = type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e9
                except OverflowError:
                    finite = False
                if not finite:
                    raise ValueError("坐标必须是范围内的有限数值")
            flat.append(point)
    if max(max(p[i] for p in flat) - min(p[i] for p in flat) for i in (0, 1)) <= 1e-9:
        raise ValueError("整体几何不能退化为单点")


def validate_sample(sample: Sample) -> None:
    """严格校验标签、来源及划分；不允许提示词自动升级为人工确认监督，非法值抛 ValueError。"""
    fields = {"schema_version", "sample_id", "group_id", "split", "label", "label_status", "paths", "provenance"}
    if not isinstance(sample, dict) or set(sample) != fields:
        raise ValueError("分类样本字段不符")
    if type(sample["schema_version"]) is not int or sample["schema_version"] != 1:
        raise ValueError("分类样本版本不符")
    if not isinstance(sample["sample_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", sample["sample_id"]):
        raise ValueError("sample_id 必须是稳定的内容标识")
    if not isinstance(sample["group_id"], str) or not sample["group_id"]:
        raise ValueError("来源组不能为空")
    if sample["label"] not in LABELS or sample["split"] not in SPLITS:
        raise ValueError("未知分类标签或划分")
    origin = sample["provenance"]
    if not isinstance(origin, dict) or set(origin) != {"kind", "source_id", "source_sha256", "license", "source_label", "recognized", "variant"}:
        raise ValueError("来源字段不符")
    if origin["kind"] not in ("procedural", "tabler", "quickdraw"):
        raise ValueError("未知来源")
    for key in ("source_id", "source_label", "license"):
        if not isinstance(origin[key], str) or not origin[key]:
            raise ValueError("来源身份、类别和许可不能为空")
    if not isinstance(origin["source_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", origin["source_sha256"]):
        raise ValueError("来源缺少 SHA-256")
    if type(origin["variant"]) is not int or origin["variant"] not in range(3):
        raise ValueError("变体编号错误")
    if origin["kind"] == "quickdraw":
        if (sample["label_status"] != "prompt_unreviewed" or sample["split"] != "review"
                or type(origin["recognized"]) is not bool or origin["variant"] != 0
                or origin["license"] != "CC-BY-4.0"):
            raise ValueError("QuickDraw 提示词未经人工复核，只能进入 review")
    elif (sample["label_status"] != "synthetic" or sample["split"] == "review"
          or origin["recognized"] is not None):
        raise ValueError("合成标签或划分不符")
    elif origin["kind"] == "procedural" and sample["split"] != split_for_group(sample["group_id"]):
        raise ValueError("程序来源组划分不符")
    elif origin["kind"] == "tabler" and sample["split"] != "train":
        raise ValueError("本版仅使用既有训练划分的 Tabler 素材")
    validate_paths(sample["paths"])
