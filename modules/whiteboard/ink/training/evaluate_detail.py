"""按细节扰动与母图报告稳定性；合成协议不能被表述为真实手写准确率。"""

import argparse
import json
from pathlib import Path

import torch

from ..dataset.classification.acquire import file_record, publication, write_json
from .evaluate_external import _predict, summarize_sources
from .external import load_external_packages
from .inference import load_classifier


def variant_name(variant: dict) -> str:
    """按冻结变体参数命名诊断组，不根据预测或得分选择扰动档位。"""
    kind = variant["kind"]
    amount = {"jitter": "amplitude_relative_size", "retrace": "offset_relative_size",
              "tail": "length_relative_size", "gap": "missing_fraction_of_perimeter"}.get(kind)
    return kind if amount is None else f"{kind}/{variant[amount]}"


def summarize_detail(rows: list[dict], predictions: list[dict]) -> dict:
    """输出细节分类及干净图正确时的成对稳定性；身份缺失或标签不符抛ValueError。"""
    indexed = {row["sample_id"]: row for row in predictions}
    if len(indexed) != len(predictions) or set(indexed) != {row["sample_id"] for row in rows}:
        raise ValueError("细节诊断的预测与固定样本身份不符")
    clean, grouped = {}, []
    for row in rows:
        prediction = indexed[row["sample_id"]]
        if prediction["label"] != row["label"]:
            raise ValueError("细节诊断真值不能由预测改写")
        if row["provenance"]["variant"]["kind"] == "clean":
            if row["parent_id"] in clean:
                raise ValueError("细节母图存在重复干净参考")
            clean[row["parent_id"]] = prediction
        grouped.append({**prediction, "source": variant_name(row["provenance"]["variant"]),
                        "parent_id": row["parent_id"]})
    reports = summarize_sources(grouped)
    for name, report in reports.items():
        selected = [row for row in grouped if row["source"] == name]
        eligible = [row for row in selected if clean.get(row["parent_id"], {}).get("prediction") == row["label"]]
        report["correct_at_0.5"] = sum(row["prediction"] == row["label"] and row["score"] >= .5 for row in selected)
        report["pairs_with_correct_clean"] = len(eligible)
        report["accuracy_given_correct_clean"] = (sum(row["prediction"] == row["label"] for row in eligible) / len(eligible)
                                                   if eligible else None)
    return reports


def evaluate(checkpoints: list[Path], dataset: Path, output: Path, device: str = "cpu") -> dict:
    """固定test后比较同组细节稳定性；训练来源指纹不同或模型输出违约时拒绝发布。"""
    package = load_external_packages([dataset])
    if package["metadata"][0]["dataset"] != "shape-detail-invariance-v1":
        raise ValueError("细节诊断只接受已验证的解析母图协议")
    rows = [json.loads(line) for line in (dataset / "test.jsonl").read_text().splitlines()]
    torch.set_num_threads(4)
    target = torch.device(device)
    models, excluded = [], set()
    for checkpoint in checkpoints:
        model, transform, metadata = load_classifier(checkpoint, torch.device("cpu"))
        for source in metadata.get("external_datasets", []):
            if source["directory"] == str(dataset.resolve()) and source["manifest"] != package["metadata"][0]["manifest"]:
                raise ValueError("细节test与训练来源快照不符")
        excluded.update(row["path"] for row in (metadata.get("external_exclusions") or {}).get("removed", [])
                        if row["split"] == "test")
        models.append((checkpoint, model, transform))
    rows = [row for row in rows if str((dataset / row["image"]).resolve()) not in excluded
            and str((dataset / row["clean_image"]).resolve()) not in excluded]
    if not rows or not models:
        raise ValueError("细节诊断样本或权重不能为空")
    by_image = {str((dataset / row["image"]).resolve()): row for row in rows}
    paired = [(record, source) for record, source in zip(package["records"]["test"], package["sources"]["test"])
              if str(record[0]) in by_image]
    reports = []
    with publication(output) as staging:
        for index, (checkpoint, model, transform) in enumerate(models):
            model.to(target).eval()
            predictions = _predict(model, transform, paired, target, staging, output)
            for prediction in predictions:
                row = by_image[prediction["image"]]
                prediction.update(sample_id=row["sample_id"], parent_id=row["parent_id"],
                                  variant=row["provenance"]["variant"])
            name = f"predictions-{index}.jsonl"
            (staging / name).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in predictions))
            reports.append({"checkpoint": str(checkpoint.resolve()), "file": file_record(checkpoint),
                            "by_detail": summarize_detail(rows, predictions), "predictions_file": name,
                            "predictions": file_record(staging / name)})
            model.cpu()
        result = {"scope": "paired_synthetic_detail_test", "dataset": package["metadata"][0],
                  "samples": len(rows), "models": reports,
                  "limitations": ["合成母图隔离测试只衡量该扰动协议，不代表真实Noemori设备表现。",
                                  "只有正例，不构成文字/涂划拒绝或端到端修复准确率证据。",
                                  "干净图正确时的条件指标与全样本准确率分别报告，不能隐藏母图识别失败。"]}
        write_json(staging / "summary.json", result)
    return result


def main() -> None:
    """比较完整保存的候选；所有扰动档位保持冻结，不调模型或几何门槛。"""
    parser = argparse.ArgumentParser(description="轮廓细节鲁棒性成对诊断")
    parser.add_argument("--checkpoints", type=Path, nargs="+", required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.checkpoints, args.dataset, args.output, args.device), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
