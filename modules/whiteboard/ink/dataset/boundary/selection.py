"""仅用几何分层和稳定哈希选样；几何统计绝不生成监督标签。"""

import hashlib
import json
from pathlib import Path

import numpy as np

from ..classification.acquire import file_record
from ..classification.schema import content_hash, validate_paths
from ..real_shapes.quickdraw import assigned_split, extract_paths


def protected_keys(files: list[Path]) -> tuple[set[str], list[dict]]:
    """读取既有原始身份并保存快照；不读取预测或使用既有类别作选样依据。"""
    keys, snapshots = set(), []
    for path in files:
        count = 0
        with path.open() as handle:
            for line in handle:
                row = json.loads(line)
                sample = row.get("sample", row)
                provenance = sample.get("provenance", {})
                key = provenance.get("source_key_id", row.get("source_key_id"))
                if provenance.get("kind") == "quickdraw":
                    key = provenance["source_id"]
                if key is not None:
                    if not isinstance(key, str) or not key.isdigit():
                        raise ValueError("保护来源的QuickDraw原key非法")
                    keys.add(key)
                    count += 1
        snapshots.append({"path": str(path.resolve()), **file_record(path), "quickdraw_records": count})
    return keys, snapshots


def stratification(paths: list) -> dict | None:
    """完整单笔等弧长重采样得到轴比/闭合度，仅用作分层；复合、退化或大缺口不进入优先池。"""
    validate_paths(paths)
    if len(paths) != 1 or len(paths[0]) < 16:
        return None
    points = np.asarray(paths[0], dtype=np.float64)
    length = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))))
    keep = np.concatenate(([True], np.diff(length) > 1e-8))
    points, length = points[keep], length[keep]
    if len(points) < 16 or length[-1] < 1e-6:
        return None
    positions = np.linspace(0, length[-1], 128)
    uniform = np.column_stack([np.interp(positions, length, points[:, axis]) for axis in (0, 1)])
    extent = float(np.linalg.norm(np.ptp(uniform, axis=0)))
    if extent < 1e-6:
        return None
    gap = float(np.linalg.norm(points[-1] - points[0]) / extent)
    eigenvalues = np.linalg.eigvalsh(np.cov(uniform.T))
    ratio = float(np.sqrt(max(0.0, eigenvalues[0] / eigenvalues[1])))
    if gap > .12 or ratio < .75:
        return None
    band = "075_085" if ratio < .85 else "085_093" if ratio < .93 else "093_100"
    return {"axis_ratio": round(ratio, 8), "endpoint_gap_relative_extent": round(gap, 8),
            "band": band, "label_evidence": False}


def select_candidates(sources: Path, protected: set[str], quotas: dict) -> tuple[list[dict], dict]:
    """固定circle前缀中按原key分组并分层哈希排序；新holdout只用原记录10000行以后。"""
    manifest = json.loads((sources / "manifest.json").read_text())
    expected = manifest["files"]["circle.ndjson"]
    actual = file_record(sources / "circle.ndjson")
    if manifest.get("license") != "CC-BY-4.0" or any(actual[k] != expected[k] for k in actual):
        raise ValueError("circle来源许可或快照不符")
    pools = {(split, band): [] for split in quotas for band in quotas[split]}
    seen = set()
    with (sources / "circle.ndjson").open("rb") as handle:
        for number, line in enumerate(handle, 1):
            raw = json.loads(line)
            key = raw["key_id"]
            if key in seen:
                raise ValueError("原始前缀中key重复")
            seen.add(key)
            split = assigned_split(key)
            if key in protected or (split != "train" and number <= 10000):
                continue
            paths = extract_paths(raw, "circle")
            try:
                geometry = stratification(paths)
            except ValueError:
                continue
            if geometry is None or (split, geometry["band"]) not in pools:
                continue
            record_hash = hashlib.sha256(line).hexdigest()
            pools[split, geometry["band"]].append({
                "source_key_id": key, "assigned_split": split, "paths": paths,
                "record_line": number, "record_sha256": record_hash, "recognized": raw["recognized"],
                "sample_id": content_hash(["shape-boundary-raw-v1", key, record_hash])[:32],
                "selection_geometry": geometry,
            })
    if len(seen) != expected["records"]:
        raise ValueError("原始circle记录数不符")
    selected = []
    for (split, band), pool in pools.items():
        pool.sort(key=lambda r: content_hash(["shape-boundary-selection-v1", r["source_key_id"]]))
        selected.extend(pool[:quotas[split][band]])
    selected.sort(key=lambda r: content_hash(["shape-boundary-blind-v1", r["sample_id"]]))
    return selected, {"available": {f"{s}/{b}": len(pool) for (s, b), pool in pools.items()},
                      "quotas": quotas, "source_manifest": manifest, "source_manifest_sha256": file_record(sources / "manifest.json")["sha256"]}
