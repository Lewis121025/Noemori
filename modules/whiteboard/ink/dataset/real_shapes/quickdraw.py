"""真实圈/弧来源：整图或完整单笔提取；训练规则弱监督与独立视觉评价严格分开。"""

import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw

from ..classification.acquire import file_record, publication, write_json
from ..classification.render import render_image
from ..classification.schema import LABELS, content_hash, validate_paths
from .rules import RULE_VERSION, geometry_evidence

CANDIDATE_VERSION = "quickdraw-real-shape-candidates-v2"
REVIEWED_VERSION = "quickdraw-real-shapes-v1"
SPLITS = ("train", "val", "test", "review")


def assigned_split(key: str) -> str:
    """按原始绘图key稳定分80/10/10；所有完整笔画和后续派生始终继承同一划分。"""
    if not isinstance(key, str) or not key.isdigit():
        raise ValueError("QuickDraw key必须为数字字符串")
    bucket = int(hashlib.sha256(("real-quickdraw-group-v1|" + key).encode()).hexdigest()[:16], 16) % 100
    return "train" if bucket < 80 else "val" if bucket < 90 else "test"


def extract_paths(raw: dict, category: str) -> list[list[list[float]]]:
    """读取完整原始x/y点列，校验x/y/t等长；不切割笔画、不增广或按recognized筛选。"""
    if raw.get("word") != category or type(raw.get("recognized")) is not bool:
        raise ValueError("来源提示词或recognized元数据不合法")
    assigned_split(raw.get("key_id"))
    if not isinstance(raw.get("drawing"), list) or not raw["drawing"]:
        raise ValueError("原始drawing为空")
    paths = []
    for stroke in raw["drawing"]:
        if (not isinstance(stroke, list) or len(stroke) != 3 or not all(isinstance(axis, list) for axis in stroke)
                or len({len(axis) for axis in stroke}) != 1 or not stroke[0]):
            raise ValueError("原始stroke必须包含等长非空x/y/t数组")
        path = [[x, y] for x, y in zip(stroke[0], stroke[1])]
        if any(type(value) not in (int, float) for point in path for value in point):
            raise ValueError("原始坐标必须为数字")
        paths.append(path)
    return paths


def _source_records(sources, protected, audit):
    manifest = json.loads((sources / "manifest.json").read_text())
    if manifest.get("license") != "CC-BY-4.0":
        raise ValueError("QuickDraw来源数据许可不符")
    for name in ("circle.ndjson", "rainbow.ndjson", "SOURCE_README.txt"):
        expected = manifest["files"][name]
        if any(file_record(sources / name)[key] != expected[key] for key in ("bytes", "sha256")):
            raise ValueError("QuickDraw来源文件散列不符")
    for category, target in (("circle", "circle"), ("rainbow", "arc")):
        count = 0
        with (sources / f"{category}.ndjson").open("rb") as handle:
            for count, line in enumerate(handle, 1):
                raw = json.loads(line)
                key = raw.get("key_id")
                split = assigned_split(key)
                common = {"source_key_id": key, "source_label": category, "assigned_split": split, "record_line": count}
                if key in protected:
                    audit.append({**common, "status": "protected_existing_review_key"})
                    continue
                if category == "circle" and count > 10000 and split != "train":
                    audit.append({**common, "status": "expanded_holdout_reserved_unexported"})
                    continue
                try:
                    paths = extract_paths(raw, category)
                except ValueError as error:
                    audit.append({**common, "status": "invalid_source_record", "reason": str(error)})
                    continue
                selections = [list(range(len(paths)))] if category == "circle" else [[i] for i in range(len(paths))]
                for indices in selections:
                    selected_paths = [paths[i] for i in indices]
                    try:
                        validate_paths(selected_paths)
                        evidence = geometry_evidence(selected_paths, target)
                    except ValueError as error:
                        audit.append({**common, "stroke_indices": indices, "status": "invalid_geometry", "reason": str(error)})
                        continue
                    audit.append({**common, "stroke_indices": indices, "status": "rule_pass" if evidence["accepted"] else "rule_reject",
                                  "rule_evidence": evidence})
                    if split == "train" and not evidence["accepted"]:
                        continue
                    yield raw, selected_paths, indices, count, hashlib.sha256(line).hexdigest(), evidence, manifest
        if count != manifest["files"][f"{category}.ndjson"]["records"]:
            raise ValueError("QuickDraw来源记录数量不符")


def _make_record(raw, paths, indices, number, record_hash, rule, source_manifest, staging):
    key, category = raw["key_id"], raw["word"]
    group_split = assigned_split(key)
    identifier = content_hash(["quickdraw-raw-real-shapes", key, indices, record_hash])[:32]
    image = render_image(paths, 3)
    image_name = f"images/{identifier}.png"
    image.save(staging / image_name)
    supervised = group_split == "train" and rule["accepted"]
    return {"sample_id": identifier, "group_id": f"quickdraw-key-{key}", "writer_id": None,
            "assigned_split": group_split, "split": "train" if supervised else "review",
            "source_label": category, "label": rule["target"] if supervised else None,
            "annotation_kind": "derived_real" if supervised else "dataset_protocol",
            "annotation_status": "accepted" if supervised else "pending_visual_review",
            "review_reason": None if supervised else "提示词不是真值；val/test需要独立视觉判断，规则结果不作评价标签。",
            "paths": paths, "vertices": None, "rule_evidence": rule,
            "image": image_name, "image_sha256": file_record(staging / image_name)["sha256"],
            "pixel_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
            "provenance": {"source": "QuickDraw raw", "source_id": f"QuickDraw/{category}/{key}/" + "-".join(map(str, indices)),
                           "source_key_id": key, "original_file": f"{category}.ndjson", "record_line": number,
                           "record_sha256": record_hash, "original_sha256": source_manifest["files"][f"{category}.ndjson"]["sha256"],
                           "source_url": source_manifest["files"][f"{category}.ndjson"]["url"],
                           "source_generation": source_manifest["files"][f"{category}.ndjson"].get("generation"),
                           "source_label": category, "recognized": raw["recognized"], "stroke_indices": indices,
                           "source_stroke_count": len(raw["drawing"]), "parent_source_id": f"QuickDraw/{key}",
                           "extraction_kind": "whole_drawing" if category == "circle" else "complete_source_stroke",
                           "derivation_kind": "geometry_rule_verified_real" if supervised else "unreviewed_real_component",
                           "geometry_sha256": content_hash(paths), "license": "CC-BY-4.0",
                           "label_evidence": "固定几何规则仅用于train弱监督；word/recognized均不能单独产生真值。"}}


def _quarantine(records):
    groups = defaultdict(list)
    for record in records:
        groups[record["pixel_sha256"]].append(record)
    excluded = []
    for digest, duplicates in groups.items():
        if len({r["assigned_split"] for r in duplicates}) <= 1:
            continue
        excluded.append({"pixel_sha256": digest, "sample_ids": [r["sample_id"] for r in duplicates]})
        for record in duplicates:
            record.update({"split": "review", "label": None, "annotation_status": "excluded_cross_split_duplicate",
                           "review_reason": "完全相同RGB像素跨原始key划分，所有副本隔离。"})
    return excluded


def _review_queue(records):
    first_by_key = {}
    for record in sorted(records, key=lambda r: r["sample_id"]):
        if record["assigned_split"] not in ("val", "test") or record["annotation_status"] != "pending_visual_review":
            continue
        # 每个原图只取一个完整候选笔画，选择不使用几何规则分数或模型输出。
        first_by_key.setdefault(record["provenance"]["source_key_id"], record)
    queues = []
    for category in ("circle", "rainbow"):
        for split in ("val", "test"):
            selected = [r for r in first_by_key.values() if r["source_label"] == category and r["assigned_split"] == split]
            selected.sort(key=lambda r: content_hash(["fixed-real-shape-review-v1", r["provenance"]["source_key_id"]]))
            for position, record in enumerate(selected, 1):
                queues.append({"queue_position": position, "source_label": category, "assigned_split": split,
                               "sample_id": record["sample_id"], "source_key_id": record["provenance"]["source_key_id"],
                               "record_sha256": record["provenance"]["record_sha256"], "image": record["image"]})
    return queues


def _counts(records):
    return {"records": len(records), "splits": {s: sum(r["split"] == s for r in records) for s in SPLITS},
            "by_split_label": {s: {label: sum(r["split"] == s and r["label"] == label for r in records) for label in LABELS} for s in SPLITS},
            "annotation_kinds": dict(Counter(r["annotation_kind"] for r in records)),
            "distinct_original_keys": len({r["provenance"]["source_key_id"] for r in records}),
            "accepted_distinct_keys": {s: {label: len({r["provenance"]["source_key_id"] for r in records if r["split"] == s and r["label"] == label})
                                           for label in LABELS} for s in SPLITS[:3]},
            "by_extraction_kind": dict(Counter(r["provenance"]["extraction_kind"] for r in records))}


def _write_records(staging, records):
    with ExitStack() as stack:
        handles = {s: stack.enter_context((staging / f"{s}.jsonl").open("w")) for s in SPLITS}
        for record in records:
            handles[record["split"]].write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def generate_candidates(sources: Path, protected_dataset: Path, destination: Path) -> dict:
    """发布规则训练记录及未标注评价候选；固定原key划分，原review键和扩大部分holdout不会混训。"""
    protected = set()
    with (protected_dataset / "review.jsonl").open() as handle:
        for line in handle:
            sample = json.loads(line)["sample"]
            if sample["provenance"]["kind"] == "quickdraw":
                protected.add(sample["provenance"]["source_id"])
    audit, records = [], []
    with publication(destination) as staging:
        (staging / "images").mkdir()
        for item in _source_records(sources, protected, audit):
            records.append(_make_record(*item, staging))
        excluded = _quarantine(records)
        _write_records(staging, records)
        for name, values in (("rule-audit.jsonl", audit), ("review-queue.jsonl", _review_queue(records))):
            with (staging / name).open("w") as handle:
                for value in values:
                    handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        write_json(staging / "duplicate-quarantine.json", excluded)
        shutil.copyfile(sources / "SOURCE_README.txt", staging / "SOURCE_README.txt")
        source_manifest = json.loads((sources / "manifest.json").read_text())
        files = [*(f"{s}.jsonl" for s in SPLITS), "rule-audit.jsonl", "review-queue.jsonl", "duplicate-quarantine.json", "SOURCE_README.txt"]
        manifest = {"schema_version": 1, "dataset": CANDIDATE_VERSION, "classes": list(LABELS),
                    "source_evidence": source_manifest, "protected_review_sha256": file_record(protected_dataset / "review.jsonl")["sha256"],
                    "split_policy": {"unit": "original_quickdraw_key_id", "method": "SHA-256(real-quickdraw-group-v1|key_id),80/10/10",
                                     "writer_id_available": False, "complete_strokes_of_same_key_together": True,
                                     "evaluation_scope": "固定前10000circle/5000rainbow，扩展circle的val/test键保留且不混训。"},
                    "annotation_policy": {"train": "固定规则核验，derived_real弱监督；并非人工或AI真值。",
                                          "val_test": "未经独立视觉接受不得有标签；候选队列与规则结果及模型预测无关。"},
                    "rule": {"version": RULE_VERSION, "numpy": np.__version__,
                             "circle": "RMS<=.035,P95<=.07,协方差轴比>=.94,端点gap/r<=.20,扫角330..395,回退<=.08",
                             "arc": "RMS<=.025,P95<=.055,端点gap/r>=.45,扫角60..300,回退<=.08"},
                    "counts": _counts(records), "audit_status_counts": dict(Counter(a["status"] for a in audit)),
                    "limitations": ["word是提示词，recognized是旧游戏判断，均非真值；未按recognized筛选。",
                                    "训练规则会偏向较规整笔迹，必须用未按规则筛选的独立视觉val/test评估。",
                                    "rainbow是完整真实单笔提取，不是单独采集的圆弧；所有派生与原key同组。",
                                    "没有作者ID，不宣称按作者隔离；前缀采样也不保证人群代表性。"],
                    "files": {name: file_record(staging / name) for name in files},
                    "generator_sources": {name: file_record(Path(__file__).parent / name)["sha256"] for name in ("quickdraw.py", "rules.py")}}
        write_json(staging / "manifest.json", manifest)
        validate_quickdraw(staging)
    return manifest


def _published_decisions(directory, manifest):
    if manifest["dataset"] != REVIEWED_VERSION:
        return {}
    with (directory / "visual-review-decisions.jsonl").open() as handle:
        rows = [json.loads(line) for line in handle]
    decisions = {row["sample_id"]: row for row in rows}
    if len(decisions) != len(rows) or len(rows) != manifest["visual_review"]["decisions"]:
        raise ValueError("圈/弧盲审决定重复或数量不符")
    for decision in rows:
        if (decision.get("reviewer") != "codex_visual" or decision.get("decision") not in ("accept", "ambiguous", "exclude")
                or (decision.get("label") not in LABELS if decision["decision"] == "accept" else decision.get("label") is not None)):
            raise ValueError("圈/弧盲审决定非法")
    return decisions


def _validate_visual_review(record, decisions):
    decision = decisions.get(record["sample_id"])
    if decision is None:
        raise ValueError("圈/弧标签缺少独立盲审决定")
    expected_status = "accepted" if decision["decision"] == "accept" else decision["decision"]
    expected_split = record["assigned_split"] if expected_status == "accepted" else "review"
    if (record.get("visual_review") != decision or record["label"] != decision["label"]
            or record["annotation_status"] != expected_status or record["split"] != expected_split
            or record["assigned_split"] not in ("val", "test")
            or decision["record_sha256"] != record["provenance"]["record_sha256"]):
        raise ValueError("圈/弧标签与独立盲审决定不符")


def validate_quickdraw(directory: Path) -> dict:
    """核验圈/弧包原key分组、原始提取点、监督层次与RGB散列；伪标签或泄漏时报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") not in (CANDIDATE_VERSION, REVIEWED_VERSION) or manifest.get("classes") != list(LABELS):
        raise ValueError("真实圈/弧数据版本不符")
    required = {*(f"{split}.jsonl" for split in SPLITS), "rule-audit.jsonl", "review-queue.jsonl",
                "duplicate-quarantine.json", "SOURCE_README.txt"}
    if manifest["dataset"] == REVIEWED_VERSION:
        required.update(("visual-review-decisions.jsonl", "visual-review-evidence.json"))
    if set(manifest["files"]) != required:
        raise ValueError("真实圈/弧文件集合不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("圈/弧文件散列不符")
    decisions = _published_decisions(directory, manifest)
    records, ids, pixels, reviewed = [], set(), {}, set()
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                record = json.loads(line)
                p = record["provenance"]
                key = p["source_key_id"]
                if (record["sample_id"] in ids or record["split"] != split or record["assigned_split"] != assigned_split(key)
                        or record["group_id"] != f"quickdraw-key-{key}" or record["writer_id"] is not None):
                    raise ValueError("原始绘图key重复、分组或划分错误")
                ids.add(record["sample_id"])
                expected_id = content_hash(["quickdraw-raw-real-shapes", key, p["stroke_indices"], p["record_sha256"]])[:32]
                if expected_id != record["sample_id"] or record["image"] != f"images/{expected_id}.png" or p["license"] != "CC-BY-4.0":
                    raise ValueError("来源或样本身份不符")
                validate_paths(record["paths"])
                if content_hash(record["paths"]) != p["geometry_sha256"]:
                    raise ValueError("提取路径与来源记录不符")
                if record["annotation_kind"] == "ai_visual_review":
                    _validate_visual_review(record, decisions)
                    reviewed.add(record["sample_id"])
                if split == "review":
                    if record["label"] is not None:
                        raise ValueError("未复核候选不能携带训练标签")
                else:
                    if split != record["assigned_split"] or record["label"] not in LABELS or record["annotation_status"] != "accepted":
                        raise ValueError("圈/弧监督标签或源key划分不符")
                    if split == "train":
                        if record["annotation_kind"] != "derived_real":
                            raise ValueError("圈/弧train只能使用显式几何规则弱监督")
                        expected = geometry_evidence(record["paths"], record["label"])
                        if expected != record["rule_evidence"] or not expected["accepted"]:
                            raise ValueError("训练弱标签不能通过声明的几何规则")
                    elif record["annotation_kind"] != "ai_visual_review" or not record.get("visual_review"):
                        raise ValueError("val/test必须来自独立视觉复核")
                    if pixels.setdefault(record["pixel_sha256"], split) != split:
                        raise ValueError("相同RGB像素跨监督划分")
                if file_record(directory / record["image"])["sha256"] != record["image_sha256"]:
                    raise ValueError("圈/弧图像SHA不符")
                with Image.open(directory / record["image"]) as image:
                    if image.size != (224,224) or image.mode != "RGB" or hashlib.sha256(image.tobytes()).hexdigest() != record["pixel_sha256"]:
                        raise ValueError("圈/弧像素或尺寸不符")
                records.append(record)
    counts = _counts(records)
    if (counts != manifest["counts"] or len(list((directory / "images").iterdir())) != len(records)
            or reviewed != set(decisions)):
        raise ValueError("圈/弧数据计数不符")
    return counts


def make_review_batch(dataset: Path, destination: Path, start: int = 1, stop: int = 80) -> dict:
    """按预先固定的原key队列生成盲审联系表，只展示图形与序号，不显示提示、规则或模型。"""
    if start < 1 or stop < start:
        raise ValueError("复核队列范围不合法")
    with (dataset / "review-queue.jsonl").open() as handle:
        selected = [json.loads(line) for line in handle if start <= json.loads(line)["queue_position"] <= stop]
    selected.sort(key=lambda r: content_hash(["blind-real-shapes", r["sample_id"]]))
    with publication(destination) as staging:
        with (staging / "selection.jsonl").open("w") as handle:
            for index, item in enumerate(selected, 1):
                handle.write(json.dumps({"blind_index": index, **item}) + "\n")
        for page in range((len(selected) + 31) // 32):
            sheet = Image.new("RGB", (224 * 4, 248 * 8), "#eeeeee")
            draw = ImageDraw.Draw(sheet)
            for local, item in enumerate(selected[page*32:(page+1)*32]):
                x, y = local % 4 * 224, local // 4 * 248
                with Image.open(dataset / item["image"]) as image:
                    sheet.paste(image, (x,y))
                draw.text((x+5,y+227), f"{page*32+local+1:03}", fill="black")
            sheet.save(staging / f"blind-{page+1:02}.png")
        manifest = {"schema_version": 1, "purpose": "独立AI视觉val/test复核，不是人工标注",
                    "parent_dataset": str(dataset.resolve()), "parent_manifest_sha256": file_record(dataset / "manifest.json")["sha256"],
                    "selection": {"queue_positions_inclusive": [start,stop], "one_complete_candidate_per_original_key": True,
                                  "independent_of_rule_and_model_predictions": True},
                    "counts": {"selected": len(selected), "by_pool": dict(Counter(r["source_label"]+"/"+r["assigned_split"] for r in selected))},
                    "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
        write_json(staging / "manifest.json", manifest)
    return manifest


def publish_reviewed(dataset: Path, review_directories: list[Path], destination: Path) -> dict:
    """将固定盲审批次接受项发布为AI复核val/test；拒绝队列外样本、重复决定或把holdout挪入train。"""
    validate_quickdraw(dataset)
    parent_manifest = json.loads((dataset / "manifest.json").read_text())
    parent_hash = file_record(dataset / "manifest.json")["sha256"]
    decisions, evidence = {}, []
    for directory in review_directories:
        review_manifest = json.loads((directory / "manifest.json").read_text())
        if review_manifest["parent_manifest_sha256"] != parent_hash:
            raise ValueError("盲审批次不是当前固定候选包")
        if file_record(directory / "selection.jsonl") != review_manifest["files"]["selection.jsonl"]:
            raise ValueError("盲审固定选择被改变")
        with (directory / "selection.jsonl").open() as handle:
            selection = {r["sample_id"]: r for r in map(json.loads, handle)}
        with (directory / "decisions.jsonl").open() as handle:
            batch = [json.loads(line) for line in handle]
        if len(batch) != len(selection) or {d["sample_id"] for d in batch} != set(selection):
            raise ValueError("盲审决定必须覆盖完整预先选定批次")
        digest = file_record(directory / "decisions.jsonl")["sha256"]
        for decision in batch:
            identifier = decision["sample_id"]
            if (identifier in decisions or decision["record_sha256"] != selection[identifier]["record_sha256"]
                    or decision["reviewer"] != "codex_visual" or decision["decision"] not in ("accept", "ambiguous", "exclude")
                    or (decision["label"] not in LABELS if decision["decision"] == "accept" else decision["label"] is not None)):
                raise ValueError("盲审来源、标签或重复决定不符")
            decisions[identifier] = {**decision, "decisions_file_sha256": digest}
        evidence.append({"review_manifest_sha256": file_record(directory / "manifest.json")["sha256"],
                         "decisions_sha256": digest, "selection_sha256": file_record(directory / "selection.jsonl")["sha256"],
                         "selection_policy": review_manifest["selection"], "reviewer": "codex_visual"})
    records = []
    for split in SPLITS:
        with (dataset / f"{split}.jsonl").open() as handle:
            for line in handle:
                record = json.loads(line)
                decision = decisions.get(record["sample_id"])
                if decision:
                    if record["assigned_split"] not in ("val", "test") or record["annotation_status"] != "pending_visual_review":
                        raise ValueError("盲审只能标注独立val/test候选")
                    accepted = decision["decision"] == "accept"
                    record.update({"label": decision["label"], "split": record["assigned_split"] if accepted else "review",
                                   "annotation_kind": "ai_visual_review", "annotation_status": "accepted" if accepted else decision["decision"],
                                   "review_reason": decision["reason"], "visual_review": decision})
                records.append(record)
    with publication(destination) as staging:
        shutil.copytree(dataset / "images", staging / "images")
        for name in parent_manifest["files"]:
            if name not in {f"{split}.jsonl" for split in SPLITS}:
                shutil.copyfile(dataset / name, staging / name)
        _write_records(staging, records)
        write_json(staging / "visual-review-evidence.json", evidence)
        with (staging / "visual-review-decisions.jsonl").open("w") as handle:
            for decision in decisions.values():
                handle.write(json.dumps(decision, ensure_ascii=False, separators=(",", ":")) + "\n")
        manifest = dict(parent_manifest)
        names = [*parent_manifest["files"], "visual-review-evidence.json", "visual-review-decisions.jsonl"]
        manifest.update({"dataset": REVIEWED_VERSION, "parent_candidate_manifest_sha256": parent_hash,
                         "counts": _counts(records), "visual_review": {"reviewer": "codex_visual", "is_human_annotation": False,
                                                                      "decisions": len(decisions), "evidence": evidence},
                         "files": {name: file_record(staging / name) for name in names}})
        write_json(staging / "manifest.json", manifest)
        validate_quickdraw(staging)
    return manifest


def main() -> None:
    """生成真实候选或固定盲审批次，所有已有包保持不变；错误返回非零状态。"""
    parser = argparse.ArgumentParser(description="真实circle/arc来源与独立复核")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--sources", type=Path, required=True)
    generate.add_argument("--protected-dataset", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    review = commands.add_parser("review-batch")
    review.add_argument("--dataset", type=Path, required=True)
    review.add_argument("--output", type=Path, required=True)
    review.add_argument("--start", type=int, default=1)
    review.add_argument("--stop", type=int, default=80)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    publish = commands.add_parser("publish-reviewed")
    publish.add_argument("--dataset", type=Path, required=True)
    publish.add_argument("--reviews", type=Path, nargs="+", required=True)
    publish.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "generate":
            result = generate_candidates(args.sources, args.protected_dataset, args.output)["counts"]
        elif args.command == "review-batch":
            result = make_review_batch(args.dataset, args.output, args.start, args.stop)["counts"]
        elif args.command == "publish-reviewed":
            result = publish_reviewed(args.dataset, args.reviews, args.output)["counts"]
        else:
            result = validate_quickdraw(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
