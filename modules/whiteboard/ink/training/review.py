"""将固定盲审决定与模型预测关联；AI 视觉标签单独报告，不宣称人工真值。"""

import argparse
import json
from pathlib import Path

from ..dataset.classification.acquire import file_record, write_json
from ..dataset.classification.schema import LABELS
from .metrics import classification_report


def load_review_package(directory: Path, dataset_sha256: str) -> tuple[dict, list[dict]]:
    """读取带指纹的 AI 复核包；来源不符、重复身份或文件损坏均报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["dataset_manifest_sha256"] != dataset_sha256 or manifest["reviewer"] != "codex_visual":
        raise ValueError("复核包来源或复核者不兼容")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("复核文件路径或散列不符")
    decisions = [json.loads(line) for line in (directory / "decisions.jsonl").read_text().splitlines()]
    if len({row["sample_id"] for row in decisions}) != len(decisions):
        raise ValueError("复核样本身份重复")
    return manifest, decisions


def reviewed_report(decisions: list[dict], predictions: list[dict]) -> dict:
    """统计接受样本的一致率并保留歧义输入覆盖；重复/缺失/来源冲突立即报错。"""
    indexed = {row["sample_id"]: row for row in predictions}
    if len(indexed) != len(predictions) or len({row["sample_id"] for row in decisions}) != len(decisions):
        raise ValueError("预测或盲审 ID 重复")
    confusion = [[0] * len(LABELS) for _ in LABELS]
    accepted, unresolved = [], []
    for decision in decisions:
        prediction = indexed.get(decision["sample_id"])
        if prediction is None or prediction["source_sha256"] != decision["source_sha256"]:
            raise ValueError("盲审与预测来源缺失或不一致")
        if decision["reviewer"] != "codex_visual" or decision["decision"] not in ("accept", "ambiguous", "exclude"):
            raise ValueError("未知盲审者或决定")
        if decision["decision"] == "accept":
            if decision["label"] not in LABELS:
                raise ValueError("接受样本缺少合法标签")
            confusion[LABELS.index(decision["label"])][LABELS.index(prediction["prediction"])] += 1
            accepted.append((decision, prediction))
        elif decision["label"] is not None:
            raise ValueError("未确定样本不得带有强制标签")
        else:
            unresolved.append(prediction)
    metrics = classification_report(confusion, LABELS, 0)
    present = [item for item in metrics["classes"].values() if item["support"]]
    thresholds = {}
    negative = [(d, p) for d, p in accepted if d["label"] == "other"]
    for threshold in (0.5, 0.8, 0.9, 0.95, 0.99):
        eligible = [(d, p) for d, p in accepted if p["prediction"] != "other" and p["score"] >= threshold]
        thresholds[str(threshold)] = {
            "candidate_count": len(eligible),
            "agreement_with_ai_labels": sum(d["label"] == p["prediction"] for d, p in eligible) / len(eligible) if eligible else None,
            "other_ai_label_candidate_count": sum(p["prediction"] != "other" and p["score"] >= threshold for _, p in negative),
            "unresolved_candidate_count": sum(p["prediction"] != "other" and p["score"] >= threshold for p in unresolved),
        }
    return {"scope": "ai_visual_review_not_human_ground_truth", "selected": len(decisions),
            "accepted": len(accepted), "unresolved": len(unresolved),
            "agreement_with_ai_labels": metrics["accuracy"],
            "macro_f1_present_classes": sum(item["f1"] for item in present) / len(present),
            "classes": metrics["classes"], "labels": list(LABELS), "confusion": confusion,
            "threshold_diagnostics": thresholds,
            "limitations": ["单个AI视觉盲审的小样本诊断，不是人工标注或产品准确率。",
                            "未确定样本不计入一致率，但单独报告被触发的数量。",
                            "没有真实圆弧/箭头标签，不能据此评估完整八类泛化。"]}


def evaluate_review(review: Path, diagnostic: Path, output: Path) -> dict:
    """核验盲审清单后输出关联诊断；保持原始标签、预测和已有报告不变。"""
    if output.exists():
        raise ValueError("拒绝覆盖已有复核报告")
    diagnostic_manifest = json.loads((diagnostic / "summary.json").read_text())
    _, decisions = load_review_package(review, diagnostic_manifest["dataset_manifest"]["sha256"])
    predictions = [json.loads(line) for line in (diagnostic / "predictions.jsonl").read_text().splitlines()]
    report = reviewed_report(decisions, predictions)
    report["review_manifest"] = file_record(review / "manifest.json")
    report["predictions"] = file_record(diagnostic / "predictions.jsonl")
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, report)
    return report


def main() -> None:
    """运行盲审对照报告，不将任何复核样本升级成训练或正式测试数据。"""
    parser = argparse.ArgumentParser(description="AI视觉盲审对照")
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--diagnostic", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(evaluate_review(args.review, args.diagnostic, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
