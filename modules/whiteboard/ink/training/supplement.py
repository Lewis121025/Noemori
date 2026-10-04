"""独立复核的真实负例补充；原始弱标签池不改写，盲审对照集不能进入训练。"""

import hashlib
import json
from pathlib import Path

from ..dataset.classification.acquire import file_record
from ..dataset.classification.schema import LABELS
from .review import load_review_package


def partition_negatives(rows: list[dict], decisions: list[dict], heldout_ids: set[str]) -> dict:
    """校验复核来源后按原始身份划分80/20；只接受明确other，拒绝与固定诊断集相交。"""
    indexed = {row["sample"]["sample_id"]: row for row in rows}
    selected = [decision["sample_id"] for decision in decisions]
    if len(indexed) != len(rows) or len(set(selected)) != len(selected):
        raise ValueError("复核补充或原始池含重复身份")
    if heldout_ids.intersection(selected):
        raise ValueError("训练补充与固定盲审对照集相交")
    result = {"train": [], "val": []}
    for decision in decisions:
        row = indexed.get(decision["sample_id"])
        if (row is None or row["sample"]["provenance"]["source_sha256"] != decision["source_sha256"]
                or decision["reviewer"] != "codex_visual"):
            raise ValueError("补充复核来源不匹配")
        if decision["decision"] in ("ambiguous", "exclude"):
            if decision["label"] is not None:
                raise ValueError("歧义或排除记录不能有监督标签")
            continue
        if decision["decision"] != "accept" or decision["label"] != "other":
            raise ValueError("首批真实补充仅接受已复核的明确负例")
        sample = row["sample"]
        if sample["split"] != "review" or sample["provenance"]["kind"] != "quickdraw":
            raise ValueError("补充样本必须来自隔离的 QuickDraw 复核池")
        key = sample["provenance"]["source_id"]
        bucket = int(hashlib.sha256(("negative-v1|" + key).encode()).hexdigest()[:16], 16) % 5
        result["val" if bucket == 0 else "train"].append(row)
    if not result["train"] or not result["val"]:
        raise ValueError("负例训练和验证划分都必须非空")
    return result


def load_negative_supplement(dataset: Path, review: Path, heldout: Path) -> tuple[dict, dict]:
    """验证两个独立复核包并返回图像记录及审计信息；不修改原始数据或标签。"""
    fingerprint = file_record(dataset / "manifest.json")["sha256"]
    _, decisions = load_review_package(review, fingerprint)
    _, fixed = load_review_package(heldout, fingerprint)
    rows = [json.loads(line) for line in (dataset / "review.jsonl").read_text().splitlines()]
    partition = partition_negatives(rows, decisions, {item["sample_id"] for item in fixed})
    records = {}
    for split, entries in partition.items():
        records[split] = []
        for row in entries:
            path = (dataset / row["image"]).resolve()
            if not path.is_relative_to(dataset.resolve()) or file_record(path)["sha256"] != row["image_sha256"]:
                raise ValueError("真实负例图片来源或散列不符")
            records[split].append((path, LABELS.index("other")))
    metadata = {"scope": "ai_visual_reviewed_negatives_not_human_labels",
                "review_manifest": file_record(review / "manifest.json"),
                "heldout_review_manifest": file_record(heldout / "manifest.json"),
                "selected_ids": [item["sample_id"] for item in decisions],
                "splits": {split: [row["sample"]["sample_id"] for row in entries] for split, entries in partition.items()},
                "counts": {split: len(entries) for split, entries in partition.items()},
                "split_policy": "SHA-256(negative-v1|source_id)前16位模5，0为验证，其余训练",
                "limitations": ["仅AI视觉复核的少量猫/星负例，没有人工标签及绘制者隔离保证。"]}
    return records, metadata
