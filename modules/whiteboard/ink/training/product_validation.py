"""在验证集上回放产品输入与最终拟合，分类族的高分不能掩盖最终子类型错误。"""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from ..dataset.classification.acquire import file_record
from ..dataset.classification.schema import LABELS
from .inference import predict_heads


def product_report(records: list[dict], reference: dict | None = None) -> dict:
    """统计最终类别并逐样本保护已正确修复；身份漂移、重复或非法类型抛ValueError。"""
    classes = {label: {"support": 0, "correct": 0, "wrong": 0} for label in LABELS}
    previous = {row["sample_id"]: row for row in reference["records"]} if reference else None
    seen, lost, new_wrong = set(), [], []
    for row in records:
        identity, truth, label = row["sample_id"], row["truth"], row["label"]
        if identity in seen or truth not in LABELS or (label is not None and label not in LABELS[:-1]):
            raise ValueError("产品验证身份或最终类别无效")
        seen.add(identity)
        correct = label == truth and label is not None
        wrong = label is not None and label != truth
        group = classes[truth]
        group["support"] += 1
        group["correct"] += int(correct)
        group["wrong"] += int(wrong)
        if previous is not None:
            before = previous.get(identity)
            if before is None or before["truth"] != truth or before["source"] != row["source"]:
                raise ValueError("产品保留验证样本或监督漂移")
            if before["label"] == truth and not correct:
                lost.append(identity)
            if wrong and (before["label"] is None or before["label"] == truth):
                new_wrong.append(identity)
    if previous is not None and seen != set(previous):
        raise ValueError("产品保留验证样本缺失")
    if not records:
        raise ValueError("产品验证不能为空")
    return {"classes": classes, "correct": sum(g["correct"] for g in classes.values()),
            "wrong": sum(g["wrong"] for g in classes.values()), "records": records,
            "lost_correct": lost, "new_wrong": new_wrong,
            "passes_product_retention": not lost and not new_wrong}


class ProductValidation:
    """仅允许固定val来源与停笔栅格，执行当前产品代码并保留完整评价证据。"""

    def __init__(self, directory: Path, preprocessing: dict, allowed_images: set[str], isolated_samples: set[str]):
        """核验数据、渲染链及标签来源；不接受test，缓存或原监督漂移抛ValueError。"""
        self.directory = directory
        self.preprocessing = preprocessing
        manifest = json.loads((directory / "manifest.json").read_text())
        if manifest.get("split") != "val" or manifest.get("dataset") != "product-validation-v1":
            raise ValueError("选模的产品回放仅允许验证集")
        for path, expected in manifest["dependencies"].items():
            if file_record(Path(path)) != expected:
                raise ValueError("产品验证来源或执行链已改变")
        if file_record(directory / "samples.jsonl") != manifest["samples"]:
            raise ValueError("产品验证记录SHA不符")
        self.samples = list(map(json.loads, (directory / "samples.jsonl").read_text().splitlines()))
        sources, self.images, eligible, isolated = {}, {}, [], []
        for row in self.samples:
            source = Path(row["source_directory"])
            if source not in sources:
                sources[source] = {r.get("sample", r)["sample_id"]: r for r in
                                   map(json.loads, (source / "val.jsonl").read_text().splitlines())}
            original = sources[source].get(row["origin_id"])
            sample = (original.get("sample", original) if original else {})
            if (row["label"] != sample.get("label") or row["paths"] != sample.get("paths")
                    or row.get("timestamps_seconds") != sample.get("timestamps_seconds")):
                raise ValueError("产品验证标签或笔迹不属于原验证来源")
            digest = row["snapshot_sha256"]
            if digest is not None:
                image = Path(row["image"])
                if file_record(image)["sha256"] != row["image_sha256"]:
                    raise ValueError("产品验证栅格SHA不符")
                if row["sample_id"] in isolated_samples or str(image.resolve()) not in allowed_images:
                    isolated.append(row["sample_id"])
                    continue
                if digest in self.images and self.images[digest] != image:
                    raise ValueError("产品验证快照身份冲突")
                self.images[digest] = image
            eligible.append(row)
        self.samples = eligible
        if not eligible:
            raise ValueError("隔离后的产品验证不能为空")
        self.replay_samples = "".join(json.dumps(row) + "\n" for row in eligible)
        encoded = self.replay_samples.encode()
        self.metadata = {"directory": str(directory.resolve()), "manifest": file_record(directory / "manifest.json"),
                         "split": "val", "samples": len(self.samples), "snapshots": len(self.images),
                         "eligible_samples": {"bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()},
                         "isolated_samples": isolated}

    def evaluate(self, model, device, reference: dict | None = None) -> dict:
        """一次推理每个唯一快照并回放最终形状；模型或Node执行失败直接抛异常。"""
        predictions = {}
        images = list(self.images.items())
        from .data import image_transform
        transform = image_transform(tuple(self.preprocessing["mean"]), tuple(self.preprocessing["std"]), False)
        for start in range(0, len(images), 128):
            batch = images[start:start + 128]
            primary, refinement = predict_heads(model, transform, [path for _, path in batch], device)
            def candidate(values):
                index = max(range(8), key=lambda i: values[i])
                result = {"label": LABELS[index], "confidence": values[index]}
                if index in (1, 2):
                    result["oval"] = {"circle": values[1], "ellipse": values[2]}
                return result
            for i, ((digest, _), values) in enumerate(zip(batch, primary.tolist())):
                result = candidate(values)
                if refinement is not None:
                    result["refinement"] = candidate(refinement[i].tolist())
                predictions[digest] = result
        runner = Path(__file__).with_name("product_replay.mjs")
        with tempfile.TemporaryDirectory(prefix="noemori-product-validation-") as temporary:
            samples_path = Path(temporary) / "samples.jsonl"
            samples_path.write_text(self.replay_samples)
            result = subprocess.run(["node", str(runner), str(samples_path)],
                                    input=json.dumps(predictions), text=True, capture_output=True, check=True)
        records = json.loads(result.stdout)
        expected = {(r["sample_id"], r["label"], r["source"]) for r in self.samples}
        if {(r["sample_id"], r["truth"], r["source"]) for r in records} != expected:
            raise ValueError("产品回放结果样本身份不完整")
        return product_report(records, reference)
