"""仅供训练弱监督的透明几何核验；不替代独立视觉标注，也不查询当前分类模型。"""

import math

import numpy as np

from ..classification.schema import validate_paths

RULE_VERSION = "real-shape-circle-fit-v1"


def geometry_evidence(paths: list[list[list[float]]], target: str) -> dict:
    """对完整单笔作均匀弧长圆拟合；返回规则证据，不输出概率，非圆/近线/多笔拒绝自动标注。"""
    validate_paths(paths)
    if target not in ("circle", "arc"):
        raise ValueError("训练规则仅支持circle/arc")
    result = {"rule": RULE_VERSION, "target": target, "accepted": False,
              "status": "rule_only_not_human_truth", "metrics": None}
    if len(paths) != 1 or len(paths[0]) < 12:
        return result
    points = np.asarray(paths[0], dtype=np.float64)
    distance = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))))
    keep = np.concatenate(([True], np.diff(distance) > 1e-9))
    distance, points = distance[keep], points[keep]
    if len(points) < 12 or distance[-1] <= 1e-6:
        return result
    positions = np.linspace(0, distance[-1], 128)
    points = np.column_stack([np.interp(positions, distance, points[:, axis]) for axis in (0, 1)])
    extent = float(np.max(np.ptp(points, axis=0)))
    if extent <= 1e-9:
        return result
    points = (points - points.mean(axis=0)) / extent
    design = np.column_stack((2 * points, np.ones(len(points))))
    coefficients, _, rank, _ = np.linalg.lstsq(design, np.sum(points * points, axis=1), rcond=None)
    radius_squared = float(np.dot(coefficients[:2], coefficients[:2]) + coefficients[2])
    if rank != 3 or radius_squared <= 1e-9:
        return result
    radius = math.sqrt(radius_squared)
    centered = points - coefficients[:2]
    residuals = np.abs(np.linalg.norm(centered, axis=1) - radius) / radius
    angles = np.unwrap(np.arctan2(centered[:, 1], centered[:, 0]))
    sweep = float(abs(angles[-1] - angles[0]))
    travel = float(np.abs(np.diff(angles)).sum())
    backtracking = max(0.0, travel - sweep) / max(travel, 1e-9)
    covariance_axes = np.linalg.eigvalsh(np.cov(points.T))
    axis_ratio = math.sqrt(max(0, float(covariance_axes[0] / covariance_axes[1])))
    gap = float(np.linalg.norm(points[-1] - points[0]) / radius)
    rms = float(np.sqrt(np.mean(residuals * residuals)))
    p95 = float(np.quantile(residuals, .95))
    metrics = {"rms_relative_radius": rms, "p95_relative_radius": p95, "sweep_degrees": math.degrees(sweep),
               "backtracking_fraction": backtracking, "endpoint_gap_relative_radius": gap,
               "resampled_covariance_axis_ratio": axis_ratio}
    if target == "circle":
        accepted = rms <= .035 and p95 <= .07 and axis_ratio >= .94 and gap <= .20 and 330 <= math.degrees(sweep) <= 395 and backtracking <= .08
    else:
        accepted = rms <= .025 and p95 <= .055 and gap >= .45 and 60 <= math.degrees(sweep) <= 300 and backtracking <= .08
    result.update({"accepted": bool(accepted), "metrics": {key: round(value, 8) for key, value in metrics.items()}})
    return result
