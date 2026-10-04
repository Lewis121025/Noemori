"""按书写者隔离的真实手势评测；报告协议标签和各类别，不用总体分数掩盖误触发。"""

import argparse
from collections import Counter
import json
import math
from pathlib import Path

import torch

from ..dataset.classification.acquire import file_record, publication, write_json
from ..dataset.classification.schema import LABELS
from .gestures import load_gesture_records
from .inference import load_classifier, predict_images
from .metrics import classification_report


def summarize_gestures(rows: list[dict]) -> dict:
    """汇总协议分类及触发覆盖；空集、非法标签或非有限概率报错。"""
    if not rows:
        raise ValueError("真实手势评测集不能为空")
    confusion = [[0] * len(LABELS) for _ in LABELS]
    loss = 0.0
    for row in rows:
        true = LABELS.index(row["label"])
        predicted = LABELS.index(row["prediction"])
        probabilities = row["probabilities"]
        if (len(probabilities) != len(LABELS) or any(not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities)
                or not math.isclose(sum(probabilities), 1, abs_tol=1e-5)):
            raise ValueError("分类概率无效")
        confusion[true][predicted] += 1
        loss -= math.log(max(probabilities[true], 1e-30))
    result = classification_report(confusion, LABELS, loss / len(rows))
    groups = {}
    for source in sorted({row["source_label"] for row in rows}):
        subset = [row for row in rows if row["source_label"] == source]
        groups[source] = {"samples": len(subset),
                          "agreement": sum(row["label"] == row["prediction"] for row in subset) / len(subset),
                          "predictions": dict(Counter(row["prediction"] for row in subset))}
    positive = [row for row in rows if row["label"] != "other"]
    negative = [row for row in rows if row["label"] == "other"]
    result["by_source_label"] = groups
    result["threshold_diagnostics"] = {}
    for threshold in (0.5, 0.8, 0.9, 0.95, 0.99):
        eligible = [row for row in rows if row["prediction"] != "other" and row["score"] >= threshold]
        result["threshold_diagnostics"][str(threshold)] = {
            "candidate_count": len(eligible),
            "correct_candidate_fraction": (sum(row["label"] == row["prediction"] for row in eligible) / len(eligible)
                                           if eligible else None),
            "correct_positive_coverage": (sum(row["label"] == row["prediction"] and row["score"] >= threshold
                                               for row in positive) / len(positive) if positive else None),
            "negative_candidate_fraction": (sum(row["prediction"] != "other" and row["score"] >= threshold
                                                 for row in negative) / len(negative) if negative else None),
        }
    return result


def evaluate(checkpoint: Path, dataset: Path, split: str, output: Path, device: str) -> dict:
    """校验数据并评估固定划分；测试书写者曾进入该模型训练时拒绝评估。"""
    _, dataset_metadata = load_gesture_records(dataset)
    if split not in ("val", "test"):
        raise ValueError("评测仅接受验证或测试划分")
    torch.set_num_threads(4)
    target = torch.device(device)
    model, transform, metadata = load_classifier(checkpoint, target)
    trained_writers = set((metadata.get("gesture_dataset") or {}).get("writers", {}).get("train", []))
    if trained_writers & set(dataset_metadata["writers"][split]):
        raise ValueError("评测书写者曾进入训练，拒绝报告隔离结果")
    records = [json.loads(line) for line in (dataset / f"{split}.jsonl").read_text().splitlines()]
    rows = []
    for start in range(0, len(records), 64):
        batch = records[start:start + 64]
        probabilities = predict_images(model, transform, [dataset / row["image"] for row in batch], target)
        for record, scores in zip(batch, probabilities.tolist()):
            sample = record["sample"]
            predicted = max(range(len(scores)), key=scores.__getitem__)
            rows.append({"sample_id": sample["sample_id"], "label": sample["label"],
                         "writer_id": sample["provenance"]["writer_id"],
                         "source_label": sample["provenance"]["source_label"],
                         "prediction": LABELS[predicted], "score": scores[predicted], "probabilities": scores})
    report = summarize_gestures(rows)
    report.update(scope="mmg_dataset_protocol_writer_isolated", split=split,
                  writers=dataset_metadata["writers"][split], checkpoint=file_record(checkpoint),
                  dataset_manifest=dataset_metadata["manifest"],
                  limitations=["这是指定手势任务的协议标签评测，不等于任意白板上的修正意图。",
                               "此数据覆盖line/arrow/other，不评估真实圆弧等缺失类别。",
                               "分数阈值仅为诊断，不能从测试集挑选产品阈值。"])
    with publication(output) as staging:
        write_json(staging / "summary.json", report)
        (staging / "predictions.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    return report


def main() -> None:
    """独立评估已训练模型，不改变样本划分或模型参数。"""
    parser = argparse.ArgumentParser(description="真实手势协议标签评测")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--split", choices=("val", "test"), default="test")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.checkpoint, args.dataset, args.split, args.output, args.device), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
