"""导出固定单图 FP32 ONNX，并对真实与合成图像验证部署数值一致性。"""

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image
import torch

from ..dataset.classification.acquire import file_record, publication, write_json
from ..dataset.classification.generate import validate_dataset
from .inference import load_classifier


def check_outputs(reference: np.ndarray, deployed: np.ndarray) -> dict:
    """验收有限 logits、Top-1 与概率误差；数值漂移超阈值时拒绝发布导出模型。"""
    if (reference.shape != deployed.shape or reference.ndim != 2 or not len(reference)
            or not np.isfinite(reference).all() or not np.isfinite(deployed).all()):
        raise ValueError("导出输出形状或数值无效")
    probabilities = []
    for logits in (reference, deployed):
        shifted = np.exp(logits - logits.max(axis=1, keepdims=True))
        probabilities.append(shifted / shifted.sum(axis=1, keepdims=True))
    logits_error = float(np.abs(reference - deployed).max())
    probability_error = float(np.abs(probabilities[0] - probabilities[1]).max())
    mismatches = int(np.count_nonzero(reference.argmax(axis=1) != deployed.argmax(axis=1)))
    # 部署决策使用类别和 softmax 分数；logits 的整体平移不改变决策。
    # 不同 FP32 卷积/融合实现允许至多 0.1 个百分点的分数偏差，仍要求全部 Top-1 一致。
    if mismatches or probability_error > 1e-3:
        raise ValueError(f"部署一致性失败：Top-1差异{mismatches}，logits误差{logits_error}，概率误差{probability_error}")
    return {"samples": len(reference), "top1_mismatches": mismatches, "probability_atol": 1e-3,
            "max_logit_abs_error": logits_error, "max_probability_abs_error": probability_error}


def export_model(checkpoint: Path, dataset: Path, output: Path) -> dict:
    """原子导出带来源和预处理信息的模型；只有CPU参考与ORT一致才发布产物。"""
    validate_dataset(dataset)
    torch.set_num_threads(4)
    model, transform, metadata = load_classifier(checkpoint, torch.device("cpu"))
    dual = metadata.get("deployment_heads") == "original_and_refinement"
    if dual:
        from .adapter import DeploymentHeads
        model.classifier = DeploymentHeads(model.get_classifier())
    image_paths, input_counts = [], {}
    for split in ("val", "review"):
        items = [json.loads(line) for line in (dataset / f"{split}.jsonl").read_text().splitlines()]
        selected = items[::max(1, len(items) // 32)][:32]
        image_paths.extend(dataset / row["image"] for row in selected)
        input_counts[split] = len(selected)
    if metadata.get("gesture_dataset"):
        from .gestures import load_gesture_records
        gesture_records, gesture_metadata = load_gesture_records(Path(metadata["gesture_dataset"]["directory"]))
        if gesture_metadata["manifest"] != metadata["gesture_dataset"]["manifest"]:
            raise ValueError("导出验收手势数据与训练来源不符")
        records = gesture_records["val"]
        selected = records[::max(1, len(records) // 32)][:32]
        image_paths.extend(path for path, _ in selected)
        input_counts["mmg_val"] = len(selected)
    if metadata.get("external_datasets"):
        from .external import load_external_packages
        packages = load_external_packages([Path(row["directory"]) for row in metadata["external_datasets"]])
        if [(row["directory"], row["manifest"]) for row in packages["metadata"]] != [
                (row["directory"], row["manifest"]) for row in metadata["external_datasets"]]:
            raise ValueError("导出验收真实包与训练来源不符")
        for source in sorted(set(packages["sources"]["val"])):
            records = [record for record, origin in zip(packages["records"]["val"], packages["sources"]["val"])
                       if origin == source]
            selected = records[::max(1, len(records) // 32)][:32]
            image_paths.extend(path for path, _ in selected)
            input_counts["external/" + source] = len(selected)
    inputs = []
    for image_path in image_paths:
        with Image.open(image_path) as image:
            inputs.append(transform(image).unsqueeze(0))
    if not inputs:
        raise ValueError("导出验收输入不能为空")
    with publication(output) as staging:
        path = staging / "model.onnx"
        names = ["logits", "refinement_logits"] if dual else ["logits"]
        torch.onnx.export(model, (inputs[0],), str(path), input_names=["images"], output_names=names,
                          opset_version=18, dynamo=True, external_data=False)
        graph = onnx.load(path)
        onnx.helper.set_model_props(graph, {"labels": json.dumps(metadata["labels"]),
                                          "preprocessing": json.dumps(metadata["preprocessing"])})
        onnx.checker.check_model(graph)
        onnx.save(graph, path)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        reference, deployed, refinement_reference, refinement_deployed = [], [], [], []
        with torch.inference_mode():
            for tensor in inputs:
                outputs = model(tensor)
                native = session.run(None, {"images": tensor.numpy()})
                reference.append((outputs[0] if dual else outputs).numpy())
                deployed.append(native[0])
                if dual:
                    refinement_reference.append(outputs[1].numpy())
                    refinement_deployed.append(native[1])
        parity = check_outputs(np.concatenate(reference), np.concatenate(deployed))
        manifest = {"schema_version": 1, "model": metadata["model"], "labels": metadata["labels"],
                    "preprocessing": metadata["preprocessing"], "precision": "fp32", "opset": 18,
                    "input": {"name": "images", "shape": [1, 3, 224, 224], "dtype": "float32"},
                    "output": {"name": "logits", "shape": [1, len(metadata["labels"])], "dtype": "float32"},
                    "checkpoint": file_record(checkpoint), "files": {"model.onnx": file_record(path)},
                    "dataset_manifest": file_record(dataset / "manifest.json"), "parity": parity,
                    "parity_input_counts": input_counts,
                    "qualification": "仅验证导出一致性，不代表真实手写识别质量或自动修复可上线。"}
        if dual:
            manifest["refinement_output"] = {"name": "refinement_logits", "shape": [1, len(metadata["labels"])], "dtype": "float32"}
            manifest["refinement_parity"] = check_outputs(np.concatenate(refinement_reference), np.concatenate(refinement_deployed))
            manifest["deployment_heads"] = metadata["deployment_heads"]
        write_json(staging / "manifest.json", manifest)
    return manifest


def main() -> None:
    """从命令行导出并验证固定形状模型，拒绝覆盖已有部署包。"""
    parser = argparse.ArgumentParser(description="导出 MobileNetV3 几何分类 ONNX")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(export_model(args.checkpoint, args.dataset, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
