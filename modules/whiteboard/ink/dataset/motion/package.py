"""发布独立母图与运动扰动包，按固定来源索引隔离全部新旧几何/像素冲突。"""

from collections import Counter
import json
from pathlib import Path

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS, content_hash, validate_paths
from ..detail.reserved import pixel_hash, render_requests
from .geometry import DOMAIN, VERSION, parent_specs
from .reservation import collect_reservation, quarantine_reasons, validate_reservation
from .variants import variants

SPLITS = ("train", "val", "test", "review")


def _read(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def _write(path, rows):
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def _sample_row(parent, view, clean):
    return {"sample_id": view["sample_id"], "parent_id": parent["parent_id"],
            "group_id": f"synthetic-motion-parent-{parent['parent_id']}", "writer_id": None,
            "split_identity_domain": DOMAIN, "assigned_split": parent["assigned_split"], "split": parent["assigned_split"],
            "source_label": parent["label"], "label": parent["label"], "annotation_kind": "synthetic_geometry",
            "annotation_status": "accepted", "review_reason": None, "paths": view["paths"],
            "timestamps_seconds": view["timestamps_seconds"], "image": f"images/{view['sample_id']}.png",
            "clean_image": f"images/{clean['sample_id']}.png", "clean_sample_id": clean["sample_id"],
            "provenance": {"source": DOMAIN, "source_id": f"analytic/{parent['parent_id']}/{view['sample_id']}",
                           "parent_id": parent["parent_id"], "analytic_parameters": parent["parameters"],
                           "variant": view["variant"], "clean_geometry_sha256": content_hash(clean["paths"]),
                           "geometry_sha256": content_hash(view["paths"]), "is_real_handwriting": False,
                           "is_device_capture": False, "target_basis": "known_analytic_parent", "generator_version": VERSION}}


def _counts(rows, parents):
    return {"analytic_parents": len(parents), "materialized_views": len(rows), "real_handwritten_drawings": 0,
            "splits": {s: sum(r["split"] == s for r in rows) for s in SPLITS},
            "by_split_label": {s: dict(Counter(r["source_label"] for r in rows if r["split"] == s)) for s in SPLITS},
            "assigned_parent_splits": {s: sum(p["assigned_split"] == s for p in parents) for s in SPLITS[:3]},
            "accepted_parents": {s: len({r["parent_id"] for r in rows if r["split"] == s}) for s in SPLITS[:3]},
            "accepted_variants": {s: dict(Counter(r["provenance"]["variant"]["kind"] for r in rows if r["split"] == s)) for s in SPLITS[:3]},
            "other_families": dict(Counter(p["parameters"]["family"] for p in parents if p["label"] == "other")),
            "review_reasons": dict(Counter(r["review_reason"]["kind"] for r in rows if r["split"] == "review")),
            "unique_supervised_pixels": len({r["pixel_sha256"] for r in rows if r["split"] != "review"})}


def _apply_quarantine(rows, reasons):
    for row in rows:
        reason = reasons.get(row["sample_id"])
        if reason:
            row.update({"split": "review", "label": None, "annotation_status": "excluded_conflict", "review_reason": reason})


def generate_dataset(datasets: list[Path], native_caches: list[Path], renderer: Path,
                     destination: Path, per_class: int = 240) -> dict:
    """原子发布clean及八视图；固定来源/产品渲染器必须有效，失败不留下部分数据。"""
    reservation = collect_reservation(datasets, native_caches, renderer)
    fingerprint = file_record(renderer)
    parents = parent_specs(per_class)
    with publication(destination) as staging:
        (staging / "images").mkdir()
        rows, requests = [], []
        for parent in parents:
            views = variants(parent)
            for view in views:
                row = _sample_row(parent, view, views[0])
                rows.append(row)
                requests.append({"paths": row["paths"], "output": str((staging / row["image"]).resolve())})
        render_requests(renderer, requests)
        if file_record(renderer) != fingerprint:
            raise ValueError("motion渲染期间产品二进制改变")
        for row in rows:
            row["image_sha256"] = file_record(staging / row["image"])["sha256"]
            row["pixel_sha256"] = pixel_hash(staging / row["image"])
        by_id = {r["sample_id"]: r for r in rows}
        for row in rows:
            clean = by_id[row["clean_sample_id"]]
            row.update({"clean_image_sha256": clean["image_sha256"], "clean_pixel_sha256": clean["pixel_sha256"]})
        reasons = quarantine_reasons(rows, reservation)
        _apply_quarantine(rows, reasons)
        for split in SPLITS:
            _write(staging / f"{split}.jsonl", [r for r in rows if r["split"] == split])
        _write(staging / "parents.jsonl", parents)
        write_json(staging / "reservation.json", reservation)
        write_json(staging / "quarantine.json", reasons)
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS), "source": DOMAIN,
                    "split_identity_domain": DOMAIN, "annotation_kind": "synthetic_geometry", "per_class_parents": per_class,
                    "counts": _counts(rows, parents), "renderer": {"binary": fingerprint},
                    "split_policy": "新解析母图域按每类哈希排名80/10/10；原母图全部视图保留assigned_split。",
                    "pair_policy": "clean与扰动属于同一母图；新旧跨划分/异标签像素及旧几何重复隔离，clean冲突连带全部视图。",
                    "limitations": ["独立解析母图及运动噪声协议，不是真实手写、设备采集或用户意图金标。",
                                    "变速/变频/相关噪声与短突发仅增加协议覆盖，不证明个体手抖分布已被覆盖。",
                                    "额外角点采样保持目标遍历完整；低采样率可产生混叠，实际设备可能漏采角点。",
                                    "同母图视图不构成独立手绘；纯circle或line经归一化可能像素等价，严格隔离会减少有效样本。",
                                    "other仅覆盖五类明确不支持的形状，不覆盖所有文字、涂鸦或复合场景。"],
                    "generator_sources": {name: file_record(Path(__file__).parent/name) for name in ("geometry.py", "variants.py", "reservation.py", "package.py")},
                    "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest


def validate_dataset(directory: Path) -> dict:
    """独立重建母图/定时视图并核验来源、配对、像素及隔离；任何监督漂移抛ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS)
            or manifest.get("source") != DOMAIN or manifest.get("split_identity_domain") != DOMAIN
            or manifest.get("annotation_kind") != "synthetic_geometry"):
        raise ValueError("motion包版本、类别或合成来源不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory/name) != expected:
            raise ValueError("motion包文件SHA不符")
    parents = _read(directory / "parents.jsonl")
    if parents != parent_specs(manifest["per_class_parents"]):
        raise ValueError("motion独立母图参数或划分改变")
    reservation = json.loads((directory / "reservation.json").read_text())
    validate_reservation(reservation)
    if reservation["renderer"]["binary"] != manifest["renderer"]["binary"]:
        raise ValueError("motion包与保留来源产品渲染器不符")
    expected = {}
    for parent in parents:
        views = variants(parent)
        for view in views:
            expected[view["sample_id"]] = _sample_row(parent, view, views[0])
    rows, seen = [], set()
    for split in SPLITS:
        for row in _read(directory / f"{split}.jsonl"):
            identifier = row["sample_id"]
            if identifier in seen or identifier not in expected or row["split"] != split:
                raise ValueError("motion样本重复、缺失或不属于固定协议")
            seen.add(identifier)
            original = expected[identifier]
            for key, value in original.items():
                if key not in ("split", "label", "annotation_status", "review_reason") and row.get(key) != value:
                    raise ValueError("motion原始参数、时间、完整路径或来源分组不符")
            validate_paths(row["paths"])
            if len(row["paths"]) != 1 or len(row["paths"][0]) > 8192:
                raise ValueError("motion视图必须符合产品完整单笔采样上限")
            if file_record(directory/row["image"])["sha256"] != row["image_sha256"] or pixel_hash(directory/row["image"]) != row["pixel_sha256"]:
                raise ValueError("motion产品图像或像素SHA不符")
            rows.append(row)
    if seen != set(expected):
        raise ValueError("motion母图clean加八视图不完整")
    by_id = {r["sample_id"]: r for r in rows}
    for row in rows:
        clean = by_id[row["clean_sample_id"]]
        if (clean["provenance"]["variant"]["kind"] != "clean" or clean["parent_id"] != row["parent_id"]
                or clean["assigned_split"] != row["assigned_split"] or clean["image"] != row["clean_image"]
                or clean["image_sha256"] != row["clean_image_sha256"] or clean["pixel_sha256"] != row["clean_pixel_sha256"]):
            raise ValueError("motion clean配对引用或SHA不符")
    reasons = quarantine_reasons(rows, reservation)
    if reasons != json.loads((directory/"quarantine.json").read_text()):
        raise ValueError("motion全局冲突隔离证据不符")
    for row in rows:
        original = expected[row["sample_id"]]
        if row["sample_id"] in reasons:
            original.update({"split": "review", "label": None, "annotation_status": "excluded_conflict", "review_reason": reasons[row["sample_id"]]})
        if any(row[key] != original[key] for key in ("split", "label", "annotation_status", "review_reason")):
            raise ValueError("motion监督标签或隔离状态不符")
    if _counts(rows, parents) != manifest["counts"] or len(list((directory/"images").iterdir())) != len(rows):
        raise ValueError("motion母图或视图计数不符")
    return manifest["counts"]
