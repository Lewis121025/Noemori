"""原子发布并严格核验时间抖动包，继承原母图划分和已校验产品clean参考。"""

from collections import Counter, defaultdict
import json
from pathlib import Path
import shutil

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS, content_hash, validate_paths
from ..detail.geometry import clean_path, parent_specs
from ..detail.package import validate_dataset as validate_detail
from ..detail.reserved import pixel_hash, render_requests
from .variants import VERSION, variants

SPLITS = ("train", "val", "test", "review")


def _read(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def _write(path, rows):
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def quarantine_reasons(rows: list, cleans: list, reservation: dict) -> dict:
    """新视图及clean与原包跨划分同像素全部隔离；同划分参考复用不会被当作泄漏。"""
    groups = defaultdict(set)
    for split, digests in reservation["source_pixels_by_split"].items():
        for digest in digests:
            groups[digest].add(split)
    for row in rows:
        groups[row["pixel_sha256"]].add(row["assigned_split"])
        groups[row["clean_pixel_sha256"]].add(row["assigned_split"])
    conflicts = {digest for digest, splits in groups.items() if len(splits) > 1}
    reserved = set(reservation["pixel_sha256"])
    rejected_parents = {row["parent_id"] for row in cleans if row["split"] == "review"}
    reasons = {}
    for row in rows:
        if row["parent_id"] in rejected_parents:
            reasons[row["sample_id"]] = {"kind": "source_parent_excluded"}
            continue
        for field in ("clean_pixel_sha256", "pixel_sha256"):
            digest = row[field]
            if digest in conflicts or digest in reserved:
                reasons[row["sample_id"]] = {"kind": "clean_pair_conflict" if field.startswith("clean") else "view_pixel_conflict",
                                             "pixel_sha256": digest, "reserved": digest in reserved,
                                             "cross_assigned_split": digest in conflicts}
                break
    return reasons


def _counts(rows, parents):
    return {"analytic_parents": len(parents), "materialized_views": len(rows), "clean_reference_images": len(parents),
            "real_handwritten_drawings": 0, "splits": {s: sum(r["split"] == s for r in rows) for s in SPLITS},
            "by_split_label": {s: dict(Counter(r["source_label"] for r in rows if r["split"] == s)) for s in SPLITS},
            "accepted_parents": {s: len({r["parent_id"] for r in rows if r["split"] == s}) for s in SPLITS[:3]},
            "unique_supervised_pixels": len({r["pixel_sha256"] for r in rows if r["split"] != "review"})}


def generate_dataset(source: Path, renderer: Path, destination: Path) -> dict:
    """从完整校验的detail包生成六视图，产品渲染器必须相同；失败不发布半成品。"""
    validate_detail(source)
    source_manifest = json.loads((source / "manifest.json").read_text())
    fingerprint = file_record(renderer)
    if fingerprint != source_manifest["renderer"]["binary"]:
        raise ValueError("时间抖动包必须使用原clean的产品渲染器")
    parents = _read(source / "parents.jsonl")
    source_rows = [r for split in SPLITS for r in _read(source / f"{split}.jsonl")]
    cleans = [r for r in source_rows if r["provenance"]["variant"]["kind"] == "clean"]
    lookup = {r["parent_id"]: r for r in cleans}
    reservation = json.loads((source / "reservation.json").read_text())
    reservation["source_pixels_by_split"] = {s: sorted({r["pixel_sha256"] for r in source_rows if r["split"] == s}) for s in SPLITS[:3]}
    with publication(destination) as staging:
        (staging / "images").mkdir()
        (staging / "clean").mkdir()
        rows, requests = [], []
        for parent in parents:
            clean = lookup[parent["parent_id"]]
            clean_image = f"clean/{clean['sample_id']}.png"
            shutil.copyfile(source / clean["image"], staging / clean_image)
            for view in variants(parent):
                image = f"images/{view['sample_id']}.png"
                rows.append({"sample_id": view["sample_id"], "parent_id": parent["parent_id"],
                             "group_id": clean["group_id"], "writer_id": None, "split_identity_domain": "synthetic_detail",
                             "assigned_split": parent["assigned_split"], "split": parent["assigned_split"],
                             "source_label": parent["label"], "label": parent["label"],
                             "annotation_kind": "synthetic_geometry", "annotation_status": "accepted", "review_reason": None,
                             "paths": view["paths"], "timestamps_seconds": view["timestamps_seconds"], "image": image,
                             "clean_image": clean_image, "clean_sample_id": clean["sample_id"],
                             "clean_image_sha256": clean["image_sha256"], "clean_pixel_sha256": clean["pixel_sha256"],
                             "provenance": {"source": "synthetic_tremor", "source_id": f"analytic/{parent['parent_id']}/{view['sample_id']}",
                                            "parent_id": parent["parent_id"], "analytic_parameters": parent["parameters"],
                                            "variant": view["variant"], "clean_geometry_sha256": content_hash(clean["paths"]),
                                            "geometry_sha256": content_hash(view["paths"]), "is_real_handwriting": False,
                                            "is_device_capture": False, "target_basis": "known_analytic_parent", "generator_version": VERSION}})
                requests.append({"paths": view["paths"], "output": str((staging / image).resolve())})
        render_requests(renderer, requests)
        if file_record(renderer) != fingerprint:
            raise ValueError("渲染中产品二进制改变，拒绝混合fingerprint")
        for row in rows:
            row["image_sha256"] = file_record(staging / row["image"])["sha256"]
            row["pixel_sha256"] = pixel_hash(staging / row["image"])
        reasons = quarantine_reasons(rows, cleans, reservation)
        for row in rows:
            if row["sample_id"] in reasons:
                row.update({"split": "review", "label": None, "annotation_status": "excluded_pixel_conflict", "review_reason": reasons[row["sample_id"]]})
        for split in SPLITS:
            _write(staging / f"{split}.jsonl", [r for r in rows if r["split"] == split])
        _write(staging / "parents.jsonl", parents)
        _write(staging / "clean-sources.jsonl", cleans)
        write_json(staging / "source-manifest.json", source_manifest)
        write_json(staging / "reservation.json", reservation)
        write_json(staging / "quarantine.json", reasons)
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS), "source": "synthetic_tremor",
                    "annotation_kind": "synthetic_geometry", "split_identity_domain": "synthetic_detail",
                    "per_class_parents": source_manifest["per_class_parents"], "counts": _counts(rows, parents),
                    "renderer": {"binary": fingerprint}, "source_package": {"directory": str(source.resolve()),
                                                                            "manifest": file_record(source / "manifest.json")},
                    "split_policy": "继承原detail母图assigned_split及group_id；与原包、保留诊断的跨划分像素冲突隔离。",
                    "pair_policy": "clean参考直接复制原包同母图产品图；不增加独立母图数量。",
                    "limitations": ["时间相关正弦扰动的合成几何协议，不是真实设备采集或真实用户意图金标。",
                                    "角点处额外采样保证原始遍历完整，观测间隔并非严格固定。",
                                    "恒定沿轨迹速度及固定基频不能覆盖个体手抖、停顿、压力变化和复合场景。",
                                    "同母图六视图非六个独立手绘；测试母图沿用原包，不能称为全新独立测试集。"],
                    "generator_sources": {name: file_record(Path(__file__).parent / name) for name in ("variants.py", "package.py")},
                    "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest


def validate_dataset(directory: Path) -> dict:
    """重建每个定时抖动视图并核验SHA、原母图/clean配对及隔离；任何漂移抛ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS)
            or manifest.get("source") != "synthetic_tremor" or manifest.get("split_identity_domain") != "synthetic_detail"):
        raise ValueError("时间抖动包版本、类别或来源身份不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("时间抖动包文件SHA不符")
    source_manifest = json.loads((directory / "source-manifest.json").read_text())
    if source_manifest["dataset"] != "shape-detail-invariance-v1" or source_manifest["renderer"]["binary"] != manifest["renderer"]["binary"]:
        raise ValueError("时间抖动来源或产品渲染器不符")
    source = Path(manifest["source_package"]["directory"])
    if (file_record(source / "manifest.json") != manifest["source_package"]["manifest"]
            or json.loads((source / "manifest.json").read_text()) != source_manifest):
        raise ValueError("时间抖动原来源快照改变")
    validate_detail(source)
    source_rows = [r for split in SPLITS for r in _read(source / f"{split}.jsonl")]
    parents = _read(directory / "parents.jsonl")
    if parents != parent_specs(manifest["per_class_parents"]):
        raise ValueError("时间抖动原母图参数或划分不符")
    cleans = _read(directory / "clean-sources.jsonl")
    if cleans != [r for r in source_rows if r["provenance"]["variant"]["kind"] == "clean"]:
        raise ValueError("时间抖动clean来源元数据不符")
    clean_lookup = {r["parent_id"]: r for r in cleans}
    if len(cleans) != len(parents) or set(clean_lookup) != {p["parent_id"] for p in parents}:
        raise ValueError("时间抖动clean参考缺失或重复")
    expected_views = {v["sample_id"]: (p, v) for p in parents for v in variants(p)}
    rows, seen = [], set()
    for split in SPLITS:
        for row in _read(directory / f"{split}.jsonl"):
            identifier = row["sample_id"]
            if identifier in seen or identifier not in expected_views or row["split"] != split:
                raise ValueError("时间抖动视图重复或不属于协议")
            seen.add(identifier)
            parent, view = expected_views[identifier]
            clean, provenance = clean_lookup[parent["parent_id"]], row["provenance"]
            if (row["parent_id"] != parent["parent_id"] or row["assigned_split"] != parent["assigned_split"]
                    or clean["assigned_split"] != parent["assigned_split"] or clean["paths"] != [clean_path(parent["parameters"])]
                    or row["group_id"] != f"synthetic-detail-parent-{parent['parent_id']}" or row["group_id"] != clean["group_id"]
                    or row["writer_id"] is not None or row["split_identity_domain"] != "synthetic_detail"
                    or row["source_label"] != parent["label"] or row["annotation_kind"] != "synthetic_geometry"
                    or row["paths"] != view["paths"] or row["timestamps_seconds"] != view["timestamps_seconds"]
                    or provenance != {"source": "synthetic_tremor", "source_id": f"analytic/{parent['parent_id']}/{identifier}",
                                      "parent_id": parent["parent_id"], "analytic_parameters": parent["parameters"],
                                      "variant": view["variant"], "clean_geometry_sha256": content_hash(clean["paths"]),
                                      "geometry_sha256": content_hash(view["paths"]), "is_real_handwriting": False,
                                      "is_device_capture": False, "target_basis": "known_analytic_parent", "generator_version": VERSION}):
                raise ValueError("时间抖动完整遍历、原母图分组或合成来源不符")
            validate_paths(row["paths"])
            if (row["image"] != f"images/{identifier}.png" or row["clean_sample_id"] != clean["sample_id"]
                    or row["clean_image"] != f"clean/{clean['sample_id']}.png"
                    or row["clean_image_sha256"] != clean["image_sha256"] or row["clean_pixel_sha256"] != clean["pixel_sha256"]):
                raise ValueError("时间抖动clean配对引用不符")
            for field, prefix in (("image", ""), ("clean_image", "clean_")):
                image = directory / row[field]
                if file_record(image)["sha256"] != row[f"{prefix}image_sha256"] or pixel_hash(image) != row[f"{prefix}pixel_sha256"]:
                    raise ValueError("时间抖动产品图像或像素SHA不符")
            rows.append(row)
    if seen != set(expected_views):
        raise ValueError("时间抖动六视图不完整")
    reservation = json.loads((directory / "reservation.json").read_text())
    expected_reservation = json.loads((source / "reservation.json").read_text())
    expected_reservation["source_pixels_by_split"] = {s: sorted({r["pixel_sha256"] for r in source_rows if r["split"] == s}) for s in SPLITS[:3]}
    if reservation != expected_reservation:
        raise ValueError("时间抖动原来源像素隔离快照不符")
    reasons = quarantine_reasons(rows, cleans, reservation)
    if reasons != json.loads((directory / "quarantine.json").read_text()):
        raise ValueError("时间抖动像素隔离证据不符")
    for row in rows:
        reason = reasons.get(row["sample_id"])
        if reason:
            if row["split"] != "review" or row["label"] is not None or row["annotation_status"] != "excluded_pixel_conflict" or row["review_reason"] != reason:
                raise ValueError("时间抖动冲突必须全部隔离")
        elif (row["split"] != row["assigned_split"] or row["label"] != row["source_label"]
              or row["annotation_status"] != "accepted" or row["review_reason"] is not None):
            raise ValueError("时间抖动监督标签或原母图划分不符")
    if (_counts(rows, parents) != manifest["counts"] or len(list((directory / "images").iterdir())) != len(rows)
            or len(list((directory / "clean").iterdir())) != len(parents)):
        raise ValueError("时间抖动母图、视图或参考计数不符")
    return manifest["counts"]
