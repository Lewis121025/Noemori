"""保留原始分组身份的 Rust 渲染视图；只改变像素表示，不改变标签或训练划分。"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import Image

from ..dataset.classification.acquire import file_record, publication, write_json


def pixel_hash(path: Path) -> str:
    """对解码后的 RGB 像素计算散列；PNG 压缩实现不同也不能掩盖完全相同的输入。"""
    with Image.open(path) as image:
        if image.size != (224, 224):
            raise ValueError("端侧渲染图像尺寸无效")
        return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()


def prepare_native_images(datasets: list[Path], renderer: Path, output: Path,
                          reserved: Path | None = None) -> dict:
    """由已验证的数据集向量生成端侧视图；失败原子回滚，源清单与像素均记录散列。"""
    from ..dataset.classification.generate import validate_dataset
    from ..dataset.gestures.generate import validate_dataset as validate_gestures
    sources, samples = [], []
    for dataset in datasets:
        manifest = json.loads((dataset / "manifest.json").read_text())
        if manifest.get("dataset") == "gesture-classification-v1":
            validate_gestures(dataset)
        else:
            validate_dataset(dataset)
        sources.append({"directory": str(dataset.resolve()), "manifest": file_record(dataset / "manifest.json")})
        for split in ("train", "val", "test", "review"):
            path = dataset / f"{split}.jsonl"
            if path.exists():
                for row in map(json.loads, path.read_text().splitlines()):
                    sample = row["sample"]
                    samples.append((dataset, split, sample, row))
    with publication(output) as staging:
        (staging / "images").mkdir()
        records, requests = [], []
        reserved_pixels = set()
        reserved_outputs = []
        if reserved:
            (staging / "reserved").mkdir()
            for index, case in enumerate(map(json.loads, (reserved / "cases.jsonl").read_text().splitlines())):
                original = (reserved / case["image"]).resolve()
                if not original.is_relative_to(reserved.resolve()) or file_record(original)["sha256"] != case["image_sha256"]:
                    raise ValueError("独立诊断图像来源或散列不符")
                reserved_pixels.add(pixel_hash(original))
                target = staging / "reserved" / f"{index}.png"
                reserved_outputs.append(target)
                requests.append({"paths": case["paths"], "output": str(target)})
        for dataset, split, sample, row in samples:
            original = (dataset / row["image"]).resolve()
            identity = hashlib.sha256(str(original).encode()).hexdigest()
            image = f"images/{identity}.png"
            records.append({"original": str(original), "original_sha256": row["image_sha256"],
                            "split": split, "label": sample["label"], "sample_id": sample["sample_id"],
                            "group_id": sample["group_id"], "image": image})
            requests.append({"paths": sample["paths"], "output": str(staging / image)})
        subprocess.run([str(renderer.resolve())], input="".join(json.dumps(row) + "\n" for row in requests),
                       text=True, check=True)
        reserved_pixels.update(pixel_hash(path) for path in reserved_outputs)
        heldout_pixels = {split: set() for split in ("val", "test")}
        for row in records:
            row["pixel_sha256"] = pixel_hash(staging / row["image"])
            row["original_pixel_sha256"] = pixel_hash(Path(row["original"]))
            if row["split"] in heldout_pixels:
                heldout_pixels[row["split"]].update((row["pixel_sha256"], row["original_pixel_sha256"]))
        for row in records:
            row["image_sha256"] = file_record(staging / row["image"])["sha256"]
            forbidden = reserved_pixels | heldout_pixels["test"] if row["split"] == "val" else (
                reserved_pixels | heldout_pixels["test"] | heldout_pixels["val"] if row["split"] == "train" else set())
            row["exclude_native"] = row["pixel_sha256"] in forbidden
            row["exclude_original"] = row["original_pixel_sha256"] in forbidden
        (staging / "records.jsonl").write_text("".join(json.dumps(row) + "\n" for row in records))
        manifest = {"schema_version": 1, "renderer": file_record(renderer), "sources": sources,
                    "records": file_record(staging / "records.jsonl"), "count": len(records),
                    "preprocessing": "产品 Rust 等比居中/16px留白/3px线宽/3倍超采样/Lanczos3",
                    "reserved_diagnostic": file_record(reserved / "manifest.json") if reserved else None,
                    "reserved_pixel_sha256": sorted(reserved_pixels),
                    "excluded_native": sum(row["exclude_native"] for row in records),
                    "excluded_original": sum(row["exclude_original"] for row in records),
                    "policy": "保持所有原始身份、标签与划分；不读取模型预测、不合并不同对象。"}
        write_json(staging / "manifest.json", manifest)
    return manifest


def load_native_images(directory: Path, original: dict) -> tuple[dict, dict]:
    """与已验证的训练记录逐条对应；缺失、重复、改标签、移划分或篡改像素均报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("schema_version") != 1 or file_record(directory / "records.jsonl") != manifest["records"]:
        raise ValueError("端侧渲染清单版本或散列无效")
    indexed = {}
    for row in map(json.loads, (directory / "records.jsonl").read_text().splitlines()):
        key = row["original"]
        if key in indexed:
            raise ValueError("端侧渲染来源身份重复")
        indexed[key] = row
    from ..dataset.classification.schema import LABELS
    result, sources, excluded = {}, {}, {}
    reserved_pixels = set(manifest.get("reserved_pixel_sha256", []))
    heldout_pixels = {split: {digest for row in indexed.values() if row["split"] == split
                              for digest in (row.get("pixel_sha256"), row.get("original_pixel_sha256"))
                              if digest is not None} for split in ("val", "test")}
    for split, data in original.items():
        result[split] = []
        sources[split], excluded[split] = [], []
        for (path, label), source in zip(data.records, data.sources):
            row = indexed.get(str(path.resolve()))
            # 已复核负例的原始池仍是 review；只有调用方已验证的监督覆盖可决定 train/val。
            if (row is None or row["label"] != LABELS[label] or
                    (row["split"] != split and not (row["split"] == "review" and source == "ai_reviewed_quickdraw"))):
                raise ValueError("端侧渲染记录缺失或标签/划分不符")
            if file_record(path)["sha256"] != row["original_sha256"]:
                raise ValueError("端侧渲染原始图片散列不符")
            target = (directory / row["image"]).resolve()
            if not target.is_relative_to(directory.resolve()) or file_record(target)["sha256"] != row["image_sha256"]:
                raise ValueError("端侧渲染图片路径或散列不符")
            with Image.open(target) as image:
                if image.size != (224, 224) or image.mode != "RGB":
                    raise ValueError("端侧渲染图像尺寸或通道无效")
            native_digest, original_digest = pixel_hash(target), pixel_hash(path)
            if row.get("pixel_sha256", native_digest) != native_digest or row.get("original_pixel_sha256", original_digest) != original_digest:
                raise ValueError("端侧渲染像素散列不符")
            forbidden = reserved_pixels | heldout_pixels["test"] if split == "val" else (
                reserved_pixels | heldout_pixels["test"] | heldout_pixels["val"] if split == "train" else set())
            if original_digest in forbidden:
                excluded[split].append(str(path.resolve()))
            if native_digest not in forbidden:
                result[split].append((target, label))
                sources[split].append(source + "_native")
    return result, {"directory": str(directory.resolve()), "manifest": file_record(directory / "manifest.json"),
                    "sources": sources, "exclude_original": excluded}


def main() -> None:
    """预计算端侧训练视图；必须指定已经编译的产品栅格化程序，不下载或替代渲染器。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--datasets", type=Path, nargs="+", required=True)
    parser.add_argument("--renderer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reserved-diagnostic", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare_native_images(args.datasets, args.renderer, args.output, args.reserved_diagnostic), ensure_ascii=False))


if __name__ == "__main__":
    main()
