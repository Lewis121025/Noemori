"""发布母图隔离、干净/扰动成对且经产品渲染的解析几何细节不变性数据。"""

from collections import Counter, defaultdict
import json
from pathlib import Path

from PIL import Image, ImageDraw

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS, content_hash, validate_paths
from .geometry import CLASSES, VERSION, clean_path, parent_specs
from .reserved import collect_reserved, pixel_hash, render_requests
from .variants import variants

SPLITS = ("train", "val", "test", "review")


def _read(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def _write(path, rows):
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def quarantine_reasons(rows: list[dict], reserved_pixels: set[str]) -> dict[str, dict]:
    """所有跨划分同像素或保留像素冲突隔离；干净图冲突连带整个母图，防止配对引用泄漏。"""
    groups = defaultdict(set)
    for row in rows:
        groups[row["pixel_sha256"]].add(row["assigned_split"])
    conflicts = {digest for digest, splits in groups.items() if len(splits) > 1}
    blocked = conflicts | reserved_pixels
    result = {}
    for row in rows:
        clean_digest = row["clean_pixel_sha256"]
        if clean_digest in blocked or row["pixel_sha256"] in blocked:
            digest = clean_digest if clean_digest in blocked else row["pixel_sha256"]
            result[row["sample_id"]] = {"kind": "clean_pair_conflict" if clean_digest in blocked else "view_pixel_conflict",
                                       "pixel_sha256": digest, "reserved": digest in reserved_pixels,
                                       "cross_assigned_split": digest in conflicts}
    return result


def _counts(rows, parents):
    return {"analytic_parents": len(parents), "materialized_views": len(rows), "real_handwritten_drawings": 0,
            "by_split_label": {s: dict(Counter(r["source_label"] for r in rows if r["split"] == s)) for s in SPLITS},
            "splits": {s: sum(r["split"] == s for r in rows) for s in SPLITS},
            "assigned_parent_splits": {s: sum(p["assigned_split"] == s for p in parents) for s in SPLITS[:3]},
            "accepted_parents": {s: len({r["parent_id"] for r in rows if r["split"] == s}) for s in SPLITS[:3]},
            "variants": dict(Counter(r["provenance"]["variant"]["kind"] for r in rows)),
            "accepted_variant_kinds": {s: dict(Counter(r["provenance"]["variant"]["kind"] for r in rows if r["split"] == s)) for s in SPLITS[:3]},
            "unique_supervised_pixels": len({r["pixel_sha256"] for r in rows if r["split"] != "review"})}


def generate_dataset(renderer: Path, renderer_reference: Path, native_reserved: Path, clean_diagnostic: Path,
                     old_probe: Path, destination: Path, per_class: int = 160) -> dict:
    """原子发布已知目标配对视图；渲染器须匹配现用缓存，来源/渲染失败不留下半成品。"""
    fingerprint = file_record(renderer)
    reference = json.loads((renderer_reference / "manifest.json").read_text())
    if fingerprint != reference["renderer"]:
        raise ValueError("产品渲染器与当前训练缓存fingerprint不符")
    parents = parent_specs(per_class)
    with publication(destination) as staging:
        (staging / "images").mkdir()
        reservation = collect_reserved(native_reserved, clean_diagnostic, old_probe, renderer, staging)
        rows, requests = [], []
        for parent in parents:
            views = variants(parent)
            clean = views[0]
            clean_geometry = content_hash(clean["paths"])
            if clean_geometry in reservation["old_probe_clean_paths_sha256"]:
                raise ValueError("禁止复制既有细节探针母图")
            for view in views:
                image = f"images/{view['sample_id']}.png"
                rows.append({"sample_id": view["sample_id"], "parent_id": parent["parent_id"],
                             "group_id": f"synthetic-detail-parent-{parent['parent_id']}", "writer_id": None,
                             "split_identity_domain": "synthetic_detail", "assigned_split": parent["assigned_split"],
                             "split": parent["assigned_split"], "source_label": parent["label"], "label": parent["label"],
                             "annotation_kind": "synthetic_geometry", "annotation_status": "accepted", "review_reason": None,
                             "paths": view["paths"], "image": image, "clean_image": f"images/{clean['sample_id']}.png",
                             "clean_sample_id": clean["sample_id"],
                             "provenance": {"source": "synthetic_detail", "source_id": f"analytic/{parent['parent_id']}/{view['sample_id']}",
                                            "parent_id": parent["parent_id"], "analytic_parameters": parent["parameters"],
                                            "variant": view["variant"], "clean_geometry_sha256": clean_geometry,
                                            "geometry_sha256": content_hash(view["paths"]), "is_real_handwriting": False,
                                            "is_device_capture": False, "target_basis": "known_analytic_parent", "generator_version": VERSION}})
                requests.append({"paths": view["paths"], "output": str((staging / image).resolve())})
        render_requests(renderer, requests)
        if file_record(renderer) != fingerprint:
            raise ValueError("渲染过程中产品二进制改变，拒绝混合fingerprint")
        by_id = {r["sample_id"]: r for r in rows}
        for row in rows:
            row["image_sha256"] = file_record(staging / row["image"])["sha256"]
            row["pixel_sha256"] = pixel_hash(staging / row["image"])
        for row in rows:
            clean = by_id[row["clean_sample_id"]]
            row.update({"clean_image_sha256": clean["image_sha256"], "clean_pixel_sha256": clean["pixel_sha256"]})
        reasons = quarantine_reasons(rows, set(reservation["pixel_sha256"]))
        for row in rows:
            if row["sample_id"] in reasons:
                row.update({"split": "review", "label": None, "annotation_status": "excluded_pixel_conflict", "review_reason": reasons[row["sample_id"]]})
        for split in SPLITS:
            _write(staging / f"{split}.jsonl", [r for r in rows if r["split"] == split])
        _write(staging / "parents.jsonl", parents)
        write_json(staging / "reservation.json", reservation)
        write_json(staging / "quarantine.json", reasons)
        # 固定每类第一个train母图，联系表仅用于形态检查，不参与监督或选样。
        selected = [next(p for p in parents if p["label"] == label and p["assigned_split"] == "train") for label in CLASSES]
        for parent in selected:
            images = [r for r in rows if r["parent_id"] == parent["parent_id"]]
            sheet = Image.new("RGB", (224*5, 248*2), "#eeeeee")
            draw = ImageDraw.Draw(sheet)
            for index, row in enumerate(images):
                x, y = index%5*224, index//5*248
                with Image.open(staging / row["image"]) as image:
                    sheet.paste(image, (x, y))
                draw.text((x+4, y+227), f"{index}: {row['provenance']['variant']['kind']}", fill="black")
            sheet.save(staging / f"contact-{parent['label']}.png")
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS), "source": "synthetic_detail",
                    "split_identity_domain": "synthetic_detail", "annotation_kind": "synthetic_geometry", "per_class_parents": per_class,
                    "counts": _counts(rows, parents), "renderer": {"binary": fingerprint, "reference": str(renderer_reference.resolve()),
                                                                   "reference_manifest": file_record(renderer_reference / "manifest.json")},
                    "split_policy": "每类按解析母图哈希排名80/10/10；同母图所有变体同组。",
                    "pair_policy": "clean_sample_id/clean_image属于同一母图和assigned_split；干净图冲突会连带隔离全部配对视图。",
                    "limitations": ["已知解析目标的合成扰动协议，不是新增真实手写或真实用户意图证据。",
                                    "视图数量不等于独立母图数量；同轮廓回描可与clean像素相同，仍用于路径鲁棒性验证。",
                                    "合成circle经过归一化可能像素等价，所有跨划分等价或旧保留冲突均隔离。",
                                    "七类单轮廓，不涵盖复合场景、超长尾巴、重度缺口或任意涂鸦拒绝。"],
                    "generator_sources": {name: file_record(Path(__file__).parent/name) for name in ("geometry.py", "variants.py", "reserved.py", "package.py")},
                    "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest


def validate_dataset(directory: Path) -> dict:
    """逐项重建解析母图/扰动并核验SHA、配对、原划分和保留冲突；监督漂移或泄漏抛ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS) or manifest.get("source") != "synthetic_detail":
        raise ValueError("细节包版本或类别顺序不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("细节包文件SHA不符")
    parents = _read(directory / "parents.jsonl")
    if parents != parent_specs(manifest["per_class_parents"]):
        raise ValueError("解析母图参数或80/10/10分组被改变")
    reservation = json.loads((directory / "reservation.json").read_text())
    expected_views, parent_lookup = {}, {p["parent_id"]: p for p in parents}
    for parent in parents:
        for view in variants(parent):
            expected_views[view["sample_id"]] = view
    rows, seen = [], set()
    for split in SPLITS:
        for row in _read(directory / f"{split}.jsonl"):
            identifier = row["sample_id"]
            if identifier in seen or identifier not in expected_views or row["split"] != split:
                raise ValueError("细节样本重复或不属于定义视图")
            seen.add(identifier)
            parent, view = parent_lookup[row["parent_id"]], expected_views[identifier]
            provenance = row["provenance"]
            if (row["assigned_split"] != parent["assigned_split"] or row["group_id"] != f"synthetic-detail-parent-{parent['parent_id']}"
                    or row["writer_id"] is not None or row["split_identity_domain"] != "synthetic_detail"
                    or row["source_label"] != parent["label"] or row["annotation_kind"] != "synthetic_geometry"
                    or provenance["source"] != "synthetic_detail" or provenance["parent_id"] != parent["parent_id"]
                    or provenance["analytic_parameters"] != parent["parameters"] or provenance["variant"] != view["variant"]
                    or row["paths"] != view["paths"] or provenance["geometry_sha256"] != content_hash(view["paths"])
                    or provenance["is_real_handwriting"] is not False or provenance["is_device_capture"] is not False):
                raise ValueError("细节几何目标、完整单笔或来源分组不符")
            validate_paths(row["paths"])
            if len(row["paths"]) != 1 or row["image"] != f"images/{identifier}.png":
                raise ValueError("细节视图必须是单条连续路径")
            if file_record(directory / row["image"])["sha256"] != row["image_sha256"] or pixel_hash(directory / row["image"]) != row["pixel_sha256"]:
                raise ValueError("细节图像或RGB像素SHA不符")
            rows.append(row)
    if seen != set(expected_views):
        raise ValueError("细节视图不完整")
    by_id = {r["sample_id"]: r for r in rows}
    for row in rows:
        clean = by_id.get(row["clean_sample_id"])
        if (clean is None or clean["provenance"]["variant"]["kind"] != "clean" or clean["parent_id"] != row["parent_id"]
                or clean["assigned_split"] != row["assigned_split"] or row["clean_image"] != clean["image"]
                or row["clean_image_sha256"] != clean["image_sha256"] or row["clean_pixel_sha256"] != clean["pixel_sha256"]
                or row["provenance"]["clean_geometry_sha256"] != content_hash(clean["paths"])
                or content_hash(clean["paths"]) in reservation["old_probe_clean_paths_sha256"]):
            raise ValueError("细节clean配对引用、身份或旧诊断隔离不符")
    reasons = quarantine_reasons(rows, set(reservation["pixel_sha256"]))
    if reasons != json.loads((directory / "quarantine.json").read_text()):
        raise ValueError("细节像素隔离证据不符")
    for row in rows:
        reason = reasons.get(row["sample_id"])
        if reason:
            if row["split"] != "review" or row["label"] is not None or row["annotation_status"] != "excluded_pixel_conflict" or row["review_reason"] != reason:
                raise ValueError("细节冲突必须全部隔离")
        elif (row["split"] != row["assigned_split"] or row["label"] != row["source_label"]
              or row["annotation_status"] != "accepted" or row["review_reason"] is not None):
            raise ValueError("细节监督标签或母图划分不符")
    if _counts(rows, parents) != manifest["counts"] or len(list((directory / "images").iterdir())) != len(rows):
        raise ValueError("细节母图/视图计数不符")
    return manifest["counts"]
