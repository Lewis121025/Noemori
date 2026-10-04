"""解析真实笔轨迹；保持抬笔边界，速度数据不能冒充原坐标。"""

import hashlib
import re

import numpy as np

from ..classification.schema import validate_paths
from .schema import digit_split


def parse_unipen(text: str, cohort: str) -> list[dict]:
    """解析Pendigits原始UNIPEN；核对声明笔画数、字符和作者，损坏记录直接报错。"""
    rows = []
    parts = re.split(r"(?m)^\.SEGMENT\s+", text)[1:]
    for part in parts:
        lines = part.splitlines()
        header = re.fullmatch(r'DIGIT\s+(\d+)(?:-(\d+))?\s+\?\s+"([0-9])"\s*', lines[0])
        if not header:
            raise ValueError("UNIPEN段声明非法")
        first, last, label = header.groups()
        strokes = int(last or first) - int(first) + 1
        comment, paths, path = None, [], None
        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue
            if line.startswith(".COMMENT"):
                match = re.fullmatch(r"\.COMMENT\s+([0-9])\s+(\d+)\s+(\d+)", line)
                if not match or comment is not None:
                    raise ValueError("UNIPEN身份注释非法")
                comment = match.groups()
            elif line == ".PEN_DOWN":
                if path is not None:
                    raise ValueError("UNIPEN重复按笔")
                path = []
            elif line == ".PEN_UP":
                if path is None or not path:
                    raise ValueError("UNIPEN缺失笔画")
                paths.append(path)
                path = None
            elif re.fullmatch(r"\.DT\s+\d+", line):
                continue
            else:
                point = re.fullmatch(r"(-?\d+)\s+(-?\d+)", line)
                if not point or path is None:
                    raise ValueError("UNIPEN坐标出现在笔画外或非法")
                x, y = map(int, point.groups())
                path.append([float(x), float(-y)])
        if path is not None or comment is None or len(paths) != strokes or comment[0] != label:
            raise ValueError("UNIPEN段字符或笔画计数不符")
        writer, original_id = int(comment[1]), int(comment[2])
        split = digit_split(cohort, writer)
        validate_paths(paths)
        rows.append({"label": label, "cohort": cohort, "writer": writer, "original_id": original_id,
                     "split": split, "paths": paths,
                     "source_sha256": hashlib.sha256((".SEGMENT " + part).encode()).hexdigest()})
    if not rows or len({(r["writer"], r["original_id"]) for r in rows}) != len(rows):
        raise ValueError("UNIPEN为空或原始身份重复")
    return rows


def integrate_velocity(matrix, datanorm) -> list[list[list[float]]]:
    """先还原X/Y轴单位再累积平滑速度；返回屏幕坐标，非法或退化速度拒绝。"""
    values = np.asarray(matrix, dtype=np.float64)
    scales = np.asarray(datanorm, dtype=np.float64)
    if (values.ndim != 2 or values.shape[0] != 3 or values.shape[1] < 2
            or scales.shape != (3,) or not np.isfinite(values).all()
            or not np.isfinite(scales).all() or (scales <= 0).any()):
        raise ValueError("字符速度矩阵或轴归一化单位非法")
    points = np.cumsum(values[:2].T * scales[:2], axis=0)
    points[:, 1] *= -1
    paths = [points.tolist()]
    validate_paths(paths)
    return paths
