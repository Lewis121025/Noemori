"""MMG XML 与分类标签契约；保留真实用户身份，时间和压力不进入图像。"""

from dataclasses import dataclass
import hashlib
from pathlib import PurePosixPath
import re
import xml.etree.ElementTree as ET

from ..classification.schema import LABELS, content_hash, validate_paths

VERSION = "gesture-classification-v1"
MMG_SHA256 = "b11d9dcebe5f2a1ce802d106f6fc20243fd42be18558459e34004a833bc5d6a6"
XML_SHA256 = "c5d81282e46571d813fdcab06d67ef96c848c736922deaba5189a9658b1e43f6"
README_SHA256 = "7b40e8e48d25695e0f680333fb54a182f2e1c7b4c225a3ba3ef85a11870f6691"
LICENSE_ID = "MMG-custom-gesture-use"
LICENSE_QUOTE = "This is an anonymized, open-source dataset publicly available for use in gesture recognition or gesture interaction work."
WRITER_DEVICES = {str(writer): device for device, writers in (
    ("stylus", (10, 11, 12, 22, 28, 68, 71, 88, 95, 98)),
    ("finger", (41, 58, 61, 66, 73, 75, 77, 85, 94, 99)),
) for writer in writers}
# arrowhead 已核对 20 用户 × 3 速度的完整图形：有箭杆和双翼，并非孤立的尖括号。
LABEL_MAP = {"arrowhead": "arrow", "line": "line", "H": "other", "N": "other", "T": "other",
             "X": "other", "asterisk": "other", "five_point_star": "other", "six_point_star": "other",
             "null": "other", "pitchfork": "other"}
EXCLUDED_LABELS = {"I": "字母 I 与直线存在视觉重合，本版不以文字提示词硬标 other。",
                   "exclamation_point": "部分记录未显示圆点，静态图像可能只剩直线，保守隔离。",
                   "D": "本版未逐例确认闭环/弧线与字母的静态语义边界，保守隔离。",
                   "P": "本版未逐例确认字母与复合几何的边界，保守隔离。",
                   "half_note": "本版未逐例确认音符点环与连接关系，保守隔离。"}


@dataclass(frozen=True)
class Gesture:
    """一份已校验的完整原始手势；路径保留所有笔画，XML 时间和压力不作为模型特征。"""

    writer_id: str
    input_type: str
    source_label: str
    speed: str
    repetition: int
    source_id: str
    source_sha256: str
    paths: list[list[list[float]]]


def writer_assignments() -> dict[str, str]:
    """固定 20 用户按设备分层为 12/4/4；同用户所有速度、重复和类别共享划分。"""
    assignments = {}
    for device in ("finger", "stylus"):
        writers = sorted((writer for writer, kind in WRITER_DEVICES.items() if kind == device),
                         key=lambda writer: hashlib.sha256(f"mmg-user-split-v1|{writer}".encode()).hexdigest())
        for index, writer in enumerate(writers):
            assignments[writer] = "train" if index < 6 else "val" if index < 8 else "test"
    return assignments


def safe_member(name: str) -> None:
    """拒绝绝对路径、反斜线和目录穿越；只读归档也保持相同路径安全边界，非法时抛 ValueError。"""
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or ":" in name:
        raise ValueError("归档成员路径不安全")


def parse_mmg_xml(data: bytes, source_id: str) -> Gesture:
    """解析单份 MMG XML，严格校验身份、NumPts、笔画编号与坐标；实体声明或非法内容抛 ValueError。"""
    safe_member(source_id)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("MMG XML 必须使用 UTF-8，禁止其他编码绕过声明检查") from error
    if len(data) > 1_000_000 or "\x00" in text or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise ValueError("XML 过大或包含禁用的实体/DTD 声明")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        raise ValueError("XML 语法错误") from error
    required = {"Name", "Subject", "InputType", "Speed", "NumPts"}
    if root.tag != "Gesture" or set(root.attrib) != required:
        raise ValueError("MMG 根元素及元数据字段不符")
    writer, device, speed = (root.attrib[key] for key in ("Subject", "InputType", "Speed"))
    match = re.fullmatch(r"([A-Za-z_]+)~(0[1-9]|10)", root.attrib["Name"])
    if match is None or writer not in WRITER_DEVICES or WRITER_DEVICES[writer] != device or speed not in ("SLOW", "MEDIUM", "FAST"):
        raise ValueError("书写者、设备、速度或手势名称不合法")
    label, repetition = match.groups()
    expected = f"{writer}-{device}-{speed}/{writer}-{device}-{speed.lower()}-{label}-{repetition}.xml"
    if source_id != expected or label not in (LABEL_MAP.keys() | EXCLUDED_LABELS.keys()):
        raise ValueError("XML 内容与归档路径或类别不符")
    if not root.attrib["NumPts"].isdigit() or not 1 <= int(root.attrib["NumPts"]) <= 10000:
        raise ValueError("NumPts 必须为范围内正整数")
    paths = []
    for index, stroke in enumerate(root, 1):
        if stroke.tag != "Stroke" or stroke.attrib != {"index": str(index)}:
            raise ValueError("笔画索引必须连续且无未知元素")
        path = []
        for point in stroke:
            if (point.tag != "Point" or set(point.attrib) - {"X", "Y", "T", "Pressure"}
                    or not {"X", "Y"}.issubset(point.attrib) or len(point)):
                raise ValueError("Point 字段不符")
            try:
                path.append([float(point.attrib["X"]), float(point.attrib["Y"])])
            except ValueError as error:
                raise ValueError("坐标不是数字") from error
        paths.append(path)
    validate_paths(paths)
    if sum(map(len, paths)) != int(root.attrib["NumPts"]):
        raise ValueError("NumPts 与实际 Point 数量不符")
    return Gesture(writer, device, label, speed, int(repetition), source_id, hashlib.sha256(data).hexdigest(), paths)


def classification_sample(gesture: Gesture) -> dict:
    """将已验证原始手势转换为独立分类记录；未确认类别抛 ValueError，绝不自动标 other。"""
    if gesture.source_label not in LABEL_MAP:
        raise ValueError("该类别仍需隔离")
    return {"schema_version": 1, "sample_id": content_hash([MMG_SHA256, gesture.source_id, gesture.source_sha256])[:32],
            "group_id": f"mmg-writer-{gesture.writer_id}", "split": writer_assignments()[gesture.writer_id],
            "label": LABEL_MAP[gesture.source_label], "label_status": "dataset_protocol", "paths": gesture.paths,
            "provenance": {"kind": "mmg", "writer_id": gesture.writer_id, "input_type": gesture.input_type,
                           "source_label": gesture.source_label, "speed": gesture.speed, "repetition": gesture.repetition,
                           "source_id": gesture.source_id, "source_sha256": gesture.source_sha256,
                           "archive_sha256": MMG_SHA256, "license": LICENSE_ID}}


def validate_sample(sample: dict) -> None:
    """独立校验 MMG 分类记录与固定用户划分；标签、路径、来源散列或用户关系不符抛 ValueError。"""
    if (not isinstance(sample, dict) or set(sample) != {"schema_version", "sample_id", "group_id", "split", "label", "label_status", "paths", "provenance"}
            or type(sample["schema_version"]) is not int or sample["schema_version"] != 1 or sample["label_status"] != "dataset_protocol"):
        raise ValueError("MMG 样本字段或版本不符")
    p = sample["provenance"]
    if not isinstance(p, dict) or set(p) != {"kind", "writer_id", "input_type", "source_label", "speed", "repetition", "source_id", "source_sha256", "archive_sha256", "license"}:
        raise ValueError("MMG 来源字段不符")
    writer = p["writer_id"]
    if (not isinstance(writer, str) or writer not in WRITER_DEVICES or p["input_type"] != WRITER_DEVICES[writer]
            or sample["group_id"] != f"mmg-writer-{writer}" or sample["split"] != writer_assignments()[writer]):
        raise ValueError("真实书写者身份或划分不符")
    if (p["kind"] != "mmg" or p["license"] != LICENSE_ID or p["archive_sha256"] != MMG_SHA256
            or p["source_label"] not in LABEL_MAP or sample["label"] not in LABELS
            or sample["label"] != LABEL_MAP[p["source_label"]]):
        raise ValueError("来源许可或类别映射不符")
    if (p["speed"] not in ("SLOW", "MEDIUM", "FAST") or type(p["repetition"]) is not int or not 1 <= p["repetition"] <= 10
            or not isinstance(p["source_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", p["source_sha256"])):
        raise ValueError("来源速度、重复或散列不符")
    expected = f"{writer}-{p['input_type']}-{p['speed']}/{writer}-{p['input_type']}-{p['speed'].lower()}-{p['source_label']}-{p['repetition']:02}.xml"
    if p["source_id"] != expected or sample["sample_id"] != content_hash([MMG_SHA256, expected, p["source_sha256"]])[:32]:
        raise ValueError("来源路径或样本标识不符")
    validate_paths(sample["paths"])
