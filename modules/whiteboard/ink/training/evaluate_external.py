"""在相同真实保留输入上比较权重；模型预测不参与标签、划分和去重决定。"""

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import subprocess

import torch
from torch.utils.data import DataLoader

from ..dataset.classification.acquire import file_record, publication, write_json
from ..dataset.classification.schema import LABELS
from .data import ImageDataset
from .external import load_external_packages
from .inference import load_classifier
from .metrics import classification_report
from .native_images import pixel_hash


def _native_inputs(paired, datasets, renderer, staging):
    vectors = {}
    for directory in datasets:
        with (directory / "test.jsonl").open() as handle:
            for line in handle:
                row = json.loads(line)
                if row.get("paths"):
                    vectors[str((directory / row["image"]).resolve())] = row["paths"]
    (staging / "native").mkdir()
    requests, result, index = [], [], []
    for position, ((path, label), source) in enumerate(paired):
        paths = vectors.get(str(path))
        target = staging / "native" / f"{position}.png" if paths else path
        if paths:
            requests.append({"paths": paths, "output": str(target.resolve())})
            index.append({"original": str(path), "image": str(target.relative_to(staging)), "label": LABELS[label], "source": source})
        result.append(((target, label), source))
    subprocess.run([str(renderer.resolve())], input="".join(json.dumps(row) + "\n" for row in requests), text=True, check=True)
    for row in index:
        row.update(file=file_record(staging / row["image"]), pixel_sha256=pixel_hash(staging / row["image"]))
    (staging / "native-inputs.jsonl").write_text("".join(json.dumps(row) + "\n" for row in index))
    return result, {"renderer": file_record(renderer), "vector_images": len(index),
                    "raster_only_images": len(paired) - len(index), "index": file_record(staging / "native-inputs.jsonl")}


def _predict(model, transform, paired, target, staging, output):
    data = ImageDataset([row for row, _ in paired], transform, [source for _, source in paired])
    loader = DataLoader(data, batch_size=256, num_workers=4)
    predictions, offset = [], 0
    with torch.inference_mode():
        for images, labels in loader:
            logits = model(images.to(target))
            if logits.shape != (len(labels), len(LABELS)) or not torch.isfinite(logits).all():
                raise ValueError("真实数据评估输出违反模型契约")
            probabilities = logits.softmax(dim=1).cpu().tolist()
            for true, scores in zip(labels.tolist(), probabilities):
                predicted = max(range(len(scores)), key=scores.__getitem__)
                record, source = paired[offset]
                path = record[0]
                published = output / path.relative_to(staging) if path.is_relative_to(staging) else path
                predictions.append({"image": str(published.resolve()), "source": source, "label": LABELS[true],
                                    "prediction": LABELS[predicted], "score": scores[predicted], "probabilities": scores})
                offset += 1
    return predictions


def summarize_sources(predictions: list[dict]) -> dict:
    """按来源及监督种类报告分类和0.5分数门槛的负例候选；不声称经过几何修复门槛。"""
    groups = {}
    for source in sorted({row["source"] for row in predictions}):
        rows = [row for row in predictions if row["source"] == source]
        matrix = [[0] * len(LABELS) for _ in LABELS]
        for row in rows:
            matrix[LABELS.index(row["label"])][LABELS.index(row["prediction"])] += 1
        loss = sum(-math.log(max(row["probabilities"][LABELS.index(row["label"])], 1e-30)) for row in rows) / len(rows)
        report = classification_report(matrix, LABELS, loss)
        negatives = [row for row in rows if row["label"] == "other"]
        report["negative_shape_candidates_at_0.5"] = sum(row["prediction"] != "other" and row["score"] >= .5 for row in negatives)
        report["predicted_labels"] = dict(Counter(row["prediction"] for row in rows))
        groups[source] = report
    return groups


def evaluate(checkpoints: list[Path], datasets: list[Path], output: Path, device: str = "cpu",
             native_renderer: Path | None = None) -> dict:
    """校验真实包后比较固定test；每图保存置信度，来源变更或非有限推理失败不发布。"""
    external = load_external_packages(datasets)
    target = torch.device(device)
    torch.set_num_threads(4)
    excluded, models = set(), []
    for path in checkpoints:
        model, transform, metadata = load_classifier(path, torch.device("cpu"))
        trained = {p["directory"]: p["manifest"] for p in metadata.get("external_datasets", [])}
        for package in external["metadata"]:
            if package["directory"] in trained and trained[package["directory"]] != package["manifest"]:
                raise ValueError("保留评测数据与训练时的来源快照不同")
        excluded.update(row["path"] for row in (metadata.get("external_exclusions") or {}).get("removed", [])
                        if row["split"] == "test")
        models.append((path, model, transform))
    paired = [(record, source) for record, source in zip(external["records"]["test"], external["sources"]["test"])
              if str(record[0]) not in excluded]
    if not paired or not models:
        raise ValueError("保留输入和待评估权重不能为空")
    reports = []
    with publication(output) as staging:
        native = None
        if native_renderer:
            paired, native = _native_inputs(paired, datasets, native_renderer, staging)
        for index, (checkpoint, model, transform) in enumerate(models):
            model.to(target).eval()
            predictions = _predict(model, transform, paired, target, staging, output)
            groups = summarize_sources(predictions)
            name = f"predictions-{index}.jsonl"
            with (staging / name).open("w") as handle:
                for row in predictions:
                    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            reports.append({"checkpoint": str(checkpoint.resolve()), "file": file_record(checkpoint),
                            "source_tests": groups, "predictions": file_record(staging / name), "predictions_file": name})
            model.cpu()
        result = {"scope": "source_separated_real_test_with_annotation_kinds_preserved", "datasets": external["metadata"],
                  "excluded_test_images": sorted(excluded), "models": reports, "native_rendering": native,
                  "limitations": ["来源独立测试不能代替真实Noemori设备实采。", "候选数只经过分类分数门槛，未经过产品几何修复校验。",
                                  "AI视觉、规则弱监督和来源人工类别分别报告，不合并成统一人工真值准确率。"]}
        write_json(staging / "summary.json", result)
    return result


def main() -> None:
    """比较已选定权重，保留全部预测便于审查；不修改模型或训练超参数。"""
    parser = argparse.ArgumentParser(description="真实来源保留集模型比较")
    parser.add_argument("--checkpoints", type=Path, nargs="+", required=True)
    parser.add_argument("--datasets", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--native-renderer", type=Path)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.checkpoints, args.datasets, args.output, args.device, args.native_renderer), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
