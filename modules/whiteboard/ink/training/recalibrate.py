"""使用未增强的训练图像重估 BatchNorm，验证增强分布与部署输入的统计偏差。"""

import argparse
import json
from pathlib import Path

import torch

from ..dataset.classification.acquire import file_record, publication, write_json
from ..dataset.classification.generate import validate_dataset
from .data import image_transform
from .engine import reestimate_batch_norm, run_epoch, save_checkpoint
from .gestures import load_gesture_records
from .inference import load_classifier
from .supplement import load_negative_supplement
from .train import build_loaders


def recalibrate(args) -> dict:
    """同一验证集比较重估前后，改善后才发布权重并做保留测试；不修改原 checkpoint。"""
    validate_dataset(args.dataset)
    device = torch.device(args.device)
    torch.set_num_threads(4)
    model, _, metadata = load_classifier(args.checkpoint, device)
    if file_record(args.dataset / "manifest.json")["sha256"] != metadata["dataset_manifest_sha256"]:
        raise ValueError("统计重估必须使用原训练数据")
    supplement, supplement_meta = load_negative_supplement(args.dataset, args.reviewed_negatives, args.heldout_review)
    gestures, gesture_meta = load_gesture_records(args.gesture_dataset)
    if (supplement_meta != metadata["reviewed_negatives"]
            or gesture_meta != metadata["gesture_dataset"]):
        raise ValueError("补充数据或书写者划分与原训练不符")
    preprocessing = metadata["preprocessing"]
    mean, std = tuple(preprocessing["mean"]), tuple(preprocessing["std"])
    loaders = build_loaders(args.dataset, mean, std, 64, 4, metadata["seed"], device.type == "cuda", supplement, gestures)
    # 修改发生在创建迭代器之前，工作进程只能拿到真实部署的等比归一化输入。
    loaders["train"].dataset.transform = image_transform(mean, std, False)
    before = run_epoch(model, loaders["val"], device)
    details = reestimate_batch_norm(model, loaders["train"], device)
    after = run_epoch(model, loaders["val"], device)
    selected = (after["macro_f1"], -after["loss"]) > (before["macro_f1"], -before["loss"])
    report = {"selected_by_validation": selected, "before": before, "after": after,
              "reestimation": details, "source_checkpoint": file_record(args.checkpoint)}
    with publication(args.output) as staging:
        if selected:
            metadata["batch_norm_reestimation"] = {**details, "source_checkpoint": file_record(args.checkpoint)}
            save_checkpoint(staging / "best.pt", {"model": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                                                  "metadata": metadata, "validation": after})
            report["test"] = run_epoch(model, loaders["test"], device)
            report["gesture_test"] = run_epoch(model, loaders["gesture_test"], device)
        write_json(staging / "metrics.json", report)
        write_json(staging / "run.json", metadata)
    return report


def main() -> None:
    """执行一次固定的训练输入统计重估对照，不搜索测试集或改动学习参数。"""
    parser = argparse.ArgumentParser(description="BatchNorm 训练输入统计对照")
    for name in ("checkpoint", "dataset", "gesture-dataset", "reviewed-negatives", "heldout-review", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args()
    print(json.dumps(recalibrate(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
