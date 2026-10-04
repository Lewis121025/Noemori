"""产品栅格化、固定视觉复核和真实边界发布；明确来源快照与全局原key身份。"""

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS, content_hash, validate_paths
from ..real_shapes.quickdraw import assigned_split
from .selection import protected_keys, select_candidates

VERSION = "shape-boundary-review-v1"
SPLITS = ("train", "val", "test", "review")


def _read(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def _write(path, rows):
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def _pixel_hash(path):
    with Image.open(path) as image:
        if image.size != (224, 224) or image.mode != "RGB":
            raise ValueError("产品栅格图像必须为RGB224")
        return hashlib.sha256(image.tobytes()).hexdigest()


def make_candidates(sources: Path, protected_files: list[Path], renderer: Path, destination: Path, quotas: dict) -> dict:
    """将模型无关候选原子发布为产品栅格与固定盲表；不覆盖已有包，渲染失败整体回滚。"""
    protected, evidence = protected_keys(protected_files)
    selected, selection = select_candidates(sources, protected, quotas)
    with publication(destination) as staging:
        (staging / "images").mkdir()
        requests = []
        for index, row in enumerate(selected, 1):
            row.update({"blind_index": index, "image": f"images/{row['sample_id']}.png"})
            requests.append({"paths": row["paths"], "output": str((staging / row["image"]).resolve())})
        subprocess.run([str(renderer.resolve())], input="".join(json.dumps(r) + "\n" for r in requests), text=True, check=True)
        for row in selected:
            row["image_sha256"] = file_record(staging / row["image"])["sha256"]
            row["pixel_sha256"] = _pixel_hash(staging / row["image"])
        _write(staging / "selection.jsonl", selected)
        write_json(staging / "protected-keys.json", sorted(protected))
        for page in range((len(selected) + 63) // 64):
            sheet = Image.new("RGB", (160 * 8, 180 * 8), "#eeeeee")
            draw = ImageDraw.Draw(sheet)
            for offset, row in enumerate(selected[page*64:(page+1)*64]):
                x, y = offset % 8 * 160, offset // 8 * 180
                with Image.open(staging / row["image"]) as image:
                    sheet.paste(image.resize((160, 160), Image.Resampling.LANCZOS), (x, y))
                draw.text((x+4, y+162), f"{row['blind_index']:04}", fill="black")
            sheet.save(staging / f"blind-{page+1:02}.png")
        manifest = {"schema_version": 1, "dataset": "shape-boundary-candidates-v1", "selection": selection,
                    "protection": evidence, "renderer": {"binary": file_record(renderer), "kind": "product_rust_rasterizer",
                                                         "device_capture": False},
                    "selected": len(selected), "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", manifest)
    return manifest


def _counts(rows):
    return {"records": len(rows), "splits": dict(Counter(r["split"] for r in rows)),
            "by_split_label": {s: dict(Counter(r["label"] for r in rows if r["split"] == s)) for s in SPLITS[:3]},
            "distinct_original_keys": len({r["provenance"]["source_key_id"] for r in rows}),
            "accepted_axis_ratio_over_085": {label: sum(r["label"] == label and r["selection_geometry"]["axis_ratio"] > .85
                                                       for r in rows) for label in ("circle", "ellipse")}}


def publish_reviewed(candidates: Path, decisions: Path, destination: Path) -> dict:
    """固定候选的完整视觉决定转为监督；歧义隔离、跨划分同像素隔离，不借用规则标注。"""
    manifest = json.loads((candidates / "manifest.json").read_text())
    for name, expected in manifest["files"].items():
        if file_record(candidates / name) != expected:
            raise ValueError("固定候选快照被修改")
    selection = _read(candidates / "selection.jsonl")
    reviews = _read(decisions)
    indexed = {r["sample_id"]: r for r in reviews}
    if len(indexed) != len(reviews) or set(indexed) != {r["sample_id"] for r in selection}:
        raise ValueError("视觉决定必须无重复且覆盖完整固定选择")
    rows = []
    for candidate in selection:
        decision = indexed[candidate["sample_id"]]
        if (decision["record_sha256"] != candidate["record_sha256"] or decision["reviewer"] != "codex_visual"
                or decision["decision"] not in ("accept", "ambiguous", "exclude") or not decision.get("reason")
                or (decision["label"] not in ("circle", "ellipse") if decision["decision"] == "accept" else decision["label"] is not None)):
            raise ValueError("视觉决定来源、状态或标签无效")
        accepted = decision["decision"] == "accept"
        key = candidate["source_key_id"]
        rows.append({"sample_id": candidate["sample_id"], "group_id": f"quickdraw-key-{key}", "writer_id": None,
                     "split_identity_domain": "quickdraw", "assigned_split": candidate["assigned_split"],
                     "split": candidate["assigned_split"] if accepted else "review", "source_label": "circle",
                     "label": decision["label"], "annotation_kind": "ai_visual_review",
                     "annotation_status": "accepted" if accepted else decision["decision"],
                     "paths": candidate["paths"], "image": candidate["image"], "image_sha256": candidate["image_sha256"],
                     "pixel_sha256": candidate["pixel_sha256"], "visual_review": decision,
                     "selection_geometry": candidate["selection_geometry"],
                     "provenance": {"source": "QuickDraw raw", "source_key_id": key, "source_id": f"QuickDraw/circle/{key}",
                                    "record_line": candidate["record_line"], "record_sha256": candidate["record_sha256"],
                                    "original_sha256": manifest["selection"]["source_manifest"]["files"]["circle.ndjson"]["sha256"],
                                    "source_manifest_sha256": manifest["selection"]["source_manifest_sha256"],
                                    "source_url": manifest["selection"]["source_manifest"]["files"]["circle.ndjson"]["url"],
                                    "geometry_sha256": content_hash(candidate["paths"]), "recognized": candidate["recognized"],
                                    "extraction_kind": "whole_drawing", "license": "CC-BY-4.0", "device_capture": False}})
    pixels = defaultdict(list)
    for row in rows:
        pixels[row["pixel_sha256"]].append(row)
    for duplicates in pixels.values():
        if len({r["assigned_split"] for r in duplicates}) > 1:
            for row in duplicates:
                row.update({"split": "review", "label": None, "annotation_status": "excluded_cross_split_duplicate"})
    with publication(destination) as staging:
        shutil.copytree(candidates / "images", staging / "images")
        for name in ("selection.jsonl", "protected-keys.json"):
            shutil.copyfile(candidates / name, staging / name)
        shutil.copyfile(decisions, staging / "decisions.jsonl")
        shutil.copyfile(candidates / "manifest.json", staging / "candidate-manifest.json")
        for split in SPLITS:
            _write(staging / f"{split}.jsonl", [r for r in rows if r["split"] == split])
        final = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS), "split_identity_domain": "quickdraw",
                 "counts": _counts(rows), "renderer": manifest["renderer"], "selection": manifest["selection"],
                 "protection": manifest["protection"], "candidate_manifest_sha256": file_record(candidates / "manifest.json")["sha256"],
                 "limitations": ["AI视觉标注，不是人工gold；不按模型预测选样。", "单笔、轴比和闭合度分层仅用于选样，存在选择偏差。",
                                 "产品Rust渲染真实原始轨迹，不是设备实采；没有作者ID，不宣称作者隔离。",
                                 "提示词circle与recognized不是监督；近圆歧义保持label=null。"],
                 "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", final)
        validate_dataset(staging)
    return final


def validate_dataset(directory: Path) -> dict:
    """核验发布标签与冻结决定/原始点列逐项一致；禁止旧key混入、移动holdout或篡改像素。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS) or manifest.get("split_identity_domain") != "quickdraw":
        raise ValueError("边界包版本或全局身份域无效")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("边界包文件快照无效")
    candidate_manifest = json.loads((directory / "candidate-manifest.json").read_text())
    if file_record(directory / "candidate-manifest.json")["sha256"] != manifest["candidate_manifest_sha256"]:
        raise ValueError("冻结候选清单身份不符")
    for name in ("selection.jsonl", "protected-keys.json"):
        if file_record(directory / name) != candidate_manifest["files"][name]:
            raise ValueError("冻结选择或保护原key被改写")
    if manifest["selection"] != candidate_manifest["selection"] or manifest["renderer"] != candidate_manifest["renderer"]:
        raise ValueError("来源选择或渲染器证据不符")
    selection = {r["sample_id"]: r for r in _read(directory / "selection.jsonl")}
    decisions = {r["sample_id"]: r for r in _read(directory / "decisions.jsonl")}
    protected = set(json.loads((directory / "protected-keys.json").read_text()))
    rows, seen, pixels = [], set(), {}
    for split in SPLITS:
        for row in _read(directory / f"{split}.jsonl"):
            identifier, provenance = row["sample_id"], row["provenance"]
            key = provenance["source_key_id"]
            if (identifier in seen or key in protected or row["split"] != split or row["assigned_split"] != assigned_split(key)
                    or row["group_id"] != f"quickdraw-key-{key}" or row["writer_id"] is not None or row["split_identity_domain"] != "quickdraw"):
                raise ValueError("边界原key、分组或划分无效")
            seen.add(identifier)
            candidate, decision = selection[identifier], decisions[identifier]
            if (candidate["source_key_id"] != key or candidate["record_sha256"] != provenance["record_sha256"]
                    or candidate["record_line"] != provenance["record_line"] or candidate["paths"] != row["paths"]
                    or candidate["assigned_split"] != row["assigned_split"] or candidate["selection_geometry"] != row["selection_geometry"]
                    or any(candidate[k] != row[k] for k in ("image", "image_sha256", "pixel_sha256"))
                    or row["visual_review"] != decision or decision["record_sha256"] != provenance["record_sha256"]
                    or row["annotation_kind"] != "ai_visual_review" or decision["reviewer"] != "codex_visual"
                    or provenance["license"] != "CC-BY-4.0" or provenance["extraction_kind"] != "whole_drawing"
                    or provenance["source"] != "QuickDraw raw" or row["source_label"] != "circle"
                    or provenance["source_id"] != f"QuickDraw/circle/{key}" or provenance["device_capture"] is not False
                    or provenance["original_sha256"] != manifest["selection"]["source_manifest"]["files"]["circle.ndjson"]["sha256"]):
                raise ValueError("边界来源或视觉决定不符")
            validate_paths(row["paths"])
            if (content_hash(row["paths"]) != provenance["geometry_sha256"]
                    or content_hash(["shape-boundary-raw-v1", key, provenance["record_sha256"]])[:32] != identifier
                    or provenance["source_manifest_sha256"] != manifest["selection"]["source_manifest_sha256"]):
                raise ValueError("边界原始轨迹或快照身份无效")
            if row["assigned_split"] != "train" and provenance["record_line"] <= 10000:
                raise ValueError("新评价池不得使用旧前10000circle记录")
            if split == "review":
                if row["label"] is not None or row["annotation_status"] == "accepted":
                    raise ValueError("边界歧义或隔离项不能有监督标签")
                if row["annotation_status"] != "excluded_cross_split_duplicate" and (
                        decision["decision"] not in ("ambiguous", "exclude") or decision["label"] is not None
                        or row["annotation_status"] != decision["decision"]):
                    raise ValueError("隔离状态与视觉决定不符")
            elif (split != row["assigned_split"] or row["annotation_status"] != "accepted"
                  or decision["decision"] != "accept" or row["label"] != decision["label"] or row["label"] not in ("circle", "ellipse")):
                raise ValueError("边界监督与独立视觉决定不符")
            elif pixels.setdefault(row["pixel_sha256"], split) != split:
                raise ValueError("边界相同像素跨监督划分")
            if (row["image"] != f"images/{identifier}.png" or file_record(directory / row["image"])["sha256"] != row["image_sha256"]
                    or _pixel_hash(directory / row["image"]) != row["pixel_sha256"]):
                raise ValueError("边界图像路径或像素无效")
            rows.append(row)
    if seen != set(selection) or seen != set(decisions) or _counts(rows) != manifest["counts"]:
        raise ValueError("边界选择、决定或计数不完整")
    return manifest["counts"]
