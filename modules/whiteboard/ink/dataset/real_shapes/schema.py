"""HDS人工类别/顶点与Noemori八类之间的保守映射，原始与派生未知状态明确保留。"""

import csv
import io
import math
import re

from ..classification.schema import LABELS

REVISION = "a01f80248c156c56a83b2678453e410bdcc6a342"
ARCHIVE_SHA256 = "255de9a4601f59b03513159fc9ec1263a5101b9620ce777f272b491f6430d611"
README_SHA256 = "f4872309ed7b3e30fc8bb2f46061600add6e35bfc9f020380a7507f61f57b8d1"
VERSION = "hds-real-shapes-v1"
SOURCE_LABELS = ("ellipse", "rectangle", "triangle", "other")
EXPECTED_COUNTS = {"ellipse": 6454, "rectangle": 6956, "triangle": 6595, "other": 7287}
TEST_WRITERS = ("u01", "u17", "u18", "u19")
VAL_WRITERS = ("crt", "il1", "lts", "mrt", "nae")
ELLIPSE_MAX_RATIO = .85


def hds_split(writer_id: str) -> str:
    """按作者Datasheet第3页分类协议返回用户划分；同用户所有类别及未知派生始终同组。"""
    if not isinstance(writer_id, str) or not re.fullmatch(r"[a-z0-9]+", writer_id):
        raise ValueError("HDS来源用户ID非法")
    return "test" if writer_id in TEST_WRITERS else "val" if writer_id in VAL_WRITERS else "train"


def parse_vertices(data: bytes, source_label: str) -> list[list[float]]:
    """读取作者在70px原图归一化坐标上的人工顶点；数量、非有限或越界坐标抛 ValueError。"""
    expected = {"ellipse": 4, "rectangle": 4, "triangle": 3}.get(source_label)
    if expected is None:
        raise ValueError("该类别没有定义人工顶点")
    try:
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
        if len(rows) not in ({3, 4} if source_label == "triangle" else {expected}) or any(len(row) != 2 for row in rows):
            raise ValueError("人工顶点数量或列数不符")
        points = [[float(value) for value in row] for row in rows]
    except (UnicodeDecodeError, csv.Error) as error:
        raise ValueError("人工顶点CSV无效") from error
    _validate_vertices(points, source_label)
    return points


def _validate_vertices(points, source_label):
    expected = {3, 4} if source_label == "triangle" else {4}
    if not isinstance(points, list) or len(points) not in expected:
        raise ValueError("人工顶点数量不符")
    for point in points:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError("人工顶点须为二维坐标")
        for value in point:
            if type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
                raise ValueError("人工顶点坐标须为0至1的有限数值")
    if source_label == "triangle" and len(points) == 4 and points[0] != points[-1]:
        raise ValueError("三角形第四行只能是首顶点的闭合重复，不能有第四个独立顶点")


def _ellipse_axes(points):
    candidates = []
    for pairs in (((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))):
        vectors = [[points[b][i] - points[a][i] for i in (0, 1)] for a, b in pairs]
        lengths = [math.hypot(*vector) for vector in vectors]
        if min(lengths) <= .02:
            continue
        centers = [[(points[a][i] + points[b][i]) / 2 for i in (0, 1)] for a, b in pairs]
        midpoint_error = math.dist(*centers) / max(lengths)
        orthogonality_error = abs(sum(a * b for a, b in zip(*vectors))) / (lengths[0] * lengths[1])
        candidates.append((midpoint_error + orthogonality_error, min(lengths) / max(lengths),
                           midpoint_error, orthogonality_error))
    if not candidates:
        return None
    _, ratio, midpoint_error, orthogonality_error = min(candidates)
    if midpoint_error > .08 or orthogonality_error > .25:
        return None
    return {"axis_ratio": round(ratio, 8), "axis_midpoint_error": round(midpoint_error, 8),
            "axis_orthogonality_error": round(orthogonality_error, 8)}


def resolve_label(source_label: str, vertices: list[list[float]] | None) -> dict:
    """根据人工类别及顶点映射监督；近圆、宽泛other或退化标注返回待复核，不猜circle/arc。"""
    if source_label not in SOURCE_LABELS:
        raise ValueError("未知HDS来源类别")
    if source_label == "other":
        return {"label": None, "status": "pending_review", "reason": "HDS other仅排除原三类，可能含Noemori的line/arc/arrow，不能直接作负例。"}
    # HDS三角形CSV实际保存首尾闭合的四行；保留原CSV坐标，只在几何判断时去掉重复闭合点。
    if source_label == "triangle" and vertices is not None and len(vertices) == 4 and vertices[0] == vertices[-1]:
        vertices = vertices[:-1]
    if vertices is None or len({tuple(p) for p in vertices}) != len(vertices):
        return {"label": None, "status": "ambiguous", "reason": "人工顶点缺失或重合，无法可靠使用。"}
    if source_label == "ellipse":
        axes = _ellipse_axes(vertices)
        if axes is None:
            return {"label": None, "status": "ambiguous", "reason": "人工顶点不能构成可信的同心近正交双轴。"}
        if axes["axis_ratio"] > ELLIPSE_MAX_RATIO:
            return {"label": None, "status": "ambiguous", "reason": "人工椭圆目标轴比大于0.85，原类别不区分圆/近圆，保留复核。", **axes}
        return {"label": "ellipse", "status": "accepted", "reason": "作者ellipse类别及合法人工目标双轴，短长轴比不大于0.85。", **axes}
    center = [sum(p[i] for p in vertices) / len(vertices) for i in (0, 1)]
    ordered = sorted(vertices, key=lambda p: math.atan2(p[1] - center[1], p[0] - center[0]))
    area = abs(sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(ordered, [*ordered[1:], ordered[0]]))) / 2
    if area <= .0001:
        return {"label": None, "status": "ambiguous", "reason": "人工多边形目标面积退化。"}
    return {"label": source_label, "status": "accepted", "reason": "使用作者在现场采集后人工确认的形状类别和非退化目标顶点。"}


def validate_record(record: dict) -> None:
    """检查HDS记录的监督、用户划分、栅格与出处；未知派生状态或review标签被篡改时拒绝。"""
    required = {"sample_id", "group_id", "writer_id", "assigned_split", "split", "source_label", "label",
                "annotation_kind", "annotation_status", "review_reason", "vertices", "geometry_annotation",
                "image", "image_sha256", "pixel_sha256", "normalization", "provenance"}
    if not isinstance(record, dict) or set(record) != required:
        raise ValueError("HDS记录字段不符")
    writer = record["writer_id"]
    expected_split = hds_split(writer)
    if record["group_id"] != f"hds-writer-{writer}" or record["assigned_split"] != expected_split:
        raise ValueError("HDS用户分组或作者划分不符")
    for key, length in (("sample_id", 32), ("image_sha256", 64), ("pixel_sha256", 64)):
        if not isinstance(record[key], str) or not re.fullmatch(r"[0-9a-f]{" + str(length) + "}", record[key]):
            raise ValueError("样本或图像散列无效")
    if record["image"] != f"images/{record['sample_id']}.png" or record["annotation_kind"] != "human_annotation":
        raise ValueError("HDS只记录作者人工标注，不冒充AI复核或真实矢量")
    if record["source_label"] not in SOURCE_LABELS:
        raise ValueError("未知原始类别")
    if record["split"] == "review":
        if record["label"] is not None or record["annotation_status"] == "accepted":
            raise ValueError("待复核/隔离记录不得携带训练标签")
    elif (record["split"] != expected_split or record["label"] not in LABELS
          or record["annotation_status"] != "accepted"):
        raise ValueError("训练标签或用户划分非法")
    p = record["provenance"]
    if (p.get("revision") != REVISION or p.get("license") != "CC-BY-4.0" or p.get("parent_source_id") is not None
            or p.get("source_label") != record["source_label"] or p.get("source_writer_id") != writer):
        raise ValueError("HDS来源或未知母图关系不符")
    source_label = record["source_label"]
    path = p.get("original_file", "")
    prefix = f"data/user.{writer}/images/{source_label}/"
    if (not isinstance(path, str) or not path.startswith(prefix)
            or not re.fullmatch(re.escape(f"{source_label}.{writer}.") + r"\d+\.png", path[len(prefix):])
            or p.get("source_id") != f"HDS/{path}"
            or not isinstance(p.get("original_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", p["original_sha256"])):
        raise ValueError("HDS用户/类别与原始文件身份不符")
    if source_label == "other":
        if record["vertices"] is not None or p.get("vertices_file") is not None or p.get("vertices_sha256") is not None:
            raise ValueError("来源other没有人工顶点，不可虚构")
    else:
        if (p.get("vertices_file") != path.replace("/images/", "/vertices/").replace(".png", ".csv")
                or not isinstance(p.get("vertices_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", p["vertices_sha256"])):
            raise ValueError("HDS顶点文件身份不符")
        if record["vertices"] is not None:
            _validate_vertices(record["vertices"], source_label)
    expected_kind = "normalized_real_no_stretch_reported" if record["source_label"] == "other" else "source_mixture_original_or_stretched_unresolved"
    if p.get("derivation_kind") != expected_kind:
        raise ValueError("不能虚构原始/拉伸逐图对应关系")
