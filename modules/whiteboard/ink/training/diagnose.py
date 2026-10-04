"""真实 QuickDraw 复核池的弱标签诊断；提示词一致率不等于几何识别准确率。"""

import argparse
from collections import Counter
import json
from pathlib import Path

from PIL import Image, ImageDraw
import torch

from ..dataset.classification.acquire import file_record, publication, write_json
from ..dataset.classification.generate import validate_dataset
from ..dataset.classification.schema import LABELS
from .inference import load_classifier, predict_images


def summarize_predictions(rows: list[dict]) -> dict:
    """按绘制提示词和分数阈值汇总，不把弱标签分歧记成已确认模型错误。"""
    if not rows:
        raise ValueError("诊断池不能为空")
    categories = {}
    for source in sorted({row["source_label"] for row in rows}):
        subset = [row for row in rows if row["source_label"] == source]
        categories[source] = {
            "samples": len(subset),
            "prompt_agreement": sum(row["prediction"] == row["prompt_label"] for row in subset) / len(subset),
            "predictions": dict(Counter(row["prediction"] for row in subset)),
        }
    thresholds = {}
    negative = [row for row in rows if row["prompt_label"] == "other"]
    for threshold in (0.5, 0.8, 0.9, 0.95, 0.99):
        eligible = [row for row in rows if row["score"] >= threshold and row["prediction"] != "other"]
        thresholds[str(threshold)] = {
            "candidate_count": len(eligible), "candidate_fraction": len(eligible) / len(rows),
            "prompt_disagreement_count": sum(row["prediction"] != row["prompt_label"] for row in eligible),
            "other_prompt_candidate_fraction": (sum(row["score"] >= threshold and row["prediction"] != "other"
                                                       for row in negative) / len(negative) if negative else None),
        }
    return {"scope": "unreviewed_quickdraw_prompt_diagnostic", "samples": len(rows),
            "prompt_agreement": sum(row["prediction"] == row["prompt_label"] for row in rows) / len(rows),
            "by_source_label": categories, "threshold_diagnostics": thresholds,
            "limitations": ["提示词是用户被要求画的内容，不保证实际画面类别。",
                            "阈值仅用于诊断，未经校准，不是产品触发阈值。",
                            "这些样本没有进入此模型的训练，但没有绘制者身份可验证人群隔离。"]}


def write_contact_sheet(directory: Path, destination: Path, rows: list[dict]) -> None:
    """生成分歧样本图供复核，标题同时标明提示与预测，不能当作盲审素材。"""
    if not rows:
        return
    width, height, columns = 224, 260, 6
    canvas = Image.new("RGB", (columns * width, ((len(rows) + columns - 1) // columns) * height), "white")
    draw = ImageDraw.Draw(canvas)
    for i, row in enumerate(rows):
        x, y = i % columns * width, i // columns * height
        with Image.open(directory / row["image"]) as image:
            canvas.paste(image, (x, y))
        draw.text((x + 4, y + 225), f"prompt {row['prompt_label']} / pred {row['prediction']}", fill="black")
        draw.text((x + 4, y + 240), f"{row['sample_id'][:10]} / {row['score']:.3f}", fill="black")
    canvas.save(destination)


def diagnose(checkpoint: Path, dataset: Path, output: Path, device: str = "cpu") -> dict:
    """校验来源、推理复核池并原子发布诊断结果；输入/权重不兼容时拒绝发布。"""
    validate_dataset(dataset)
    records = [json.loads(line) for line in (dataset / "review.jsonl").read_text().splitlines()]
    torch.set_num_threads(4)
    target = torch.device(device)
    model, transform, metadata = load_classifier(checkpoint, target)
    selected = set((metadata.get("reviewed_negatives") or {}).get("selected_ids", []))
    original_count = len(records)
    records = [row for row in records if row["sample"]["sample_id"] not in selected]
    predictions = []
    for start in range(0, len(records), 64):
        batch = records[start:start + 64]
        probabilities = predict_images(model, transform, [dataset / row["image"] for row in batch], target)
        for row, scores in zip(batch, probabilities.tolist()):
            sample = row["sample"]
            predicted = max(range(len(scores)), key=scores.__getitem__)
            predictions.append({"sample_id": sample["sample_id"], "source_sha256": sample["provenance"]["source_sha256"],
                                "source_label": sample["provenance"]["source_label"], "prompt_label": sample["label"],
                                "image": row["image"], "prediction": LABELS[predicted], "score": scores[predicted],
                                "probabilities": scores})
    summary = summarize_predictions(predictions)
    summary["excluded_supervision_pool_samples"] = original_count - len(records)
    summary["checkpoint"] = file_record(checkpoint)
    summary["dataset_manifest"] = file_record(dataset / "manifest.json")
    with publication(output) as staging:
        write_json(staging / "summary.json", summary)
        (staging / "predictions.jsonl").write_text("".join(json.dumps(row) + "\n" for row in predictions))
        disagreements = sorted((row for row in predictions if row["prediction"] != row["prompt_label"]),
                               key=lambda row: (-row["score"], row["sample_id"]))[:48]
        write_contact_sheet(dataset, staging / "disagreements.png", disagreements)
    return summary


def main() -> None:
    """从命令行运行真实样本诊断，不修改训练数据、模型或标签。"""
    parser = argparse.ArgumentParser(description="QuickDraw 弱标签诊断")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    print(json.dumps(diagnose(args.checkpoint, args.dataset, args.output, args.device), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
