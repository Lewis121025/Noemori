"""将同一来源的产品停笔静态视图加入训练；缓存不能提供新的监督或移动划分。"""

from collections import Counter, defaultdict
import json
from pathlib import Path

from ..dataset.classification.acquire import file_record
from .data import ImageDataset
from .native_images import pixel_hash


def append_static_views(datasets: dict, directory: Path, accepted: dict,
                        excluded_origins: set[str] | None = None) -> tuple[dict, dict]:
    """核验来源绑定、PNG与像素隔离后补充派生视图；身份、标签或文件漂移抛ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != "product-static-images-v1":
        raise ValueError("停笔静态缓存版本不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("停笔静态缓存文件SHA不符")
    for path, expected in manifest["pipeline"].items():
        if file_record(Path(path)) != expected:
            raise ValueError("停笔输入或产品栅格器已改变，必须重建静态视图")
    for path, expected in manifest["source_files"].items():
        if file_record(Path(path)) != expected:
            raise ValueError("停笔静态视图的原始划分已改变")
    rows = list(map(json.loads, (directory / "records.jsonl").read_text().splitlines()))
    seen, pixels = set(), defaultdict(set)
    for split, data in datasets.items():
        for image, label in data.records:
            pixels[pixel_hash(image)].add((split, label))
    for row in rows:
        original = str(Path(row["original"]).resolve())
        image = (directory / row["image"]).resolve()
        if (original in seen or original not in accepted or accepted[original][:2] != (row["split"], row["label"])
                or not image.is_relative_to(directory.resolve())):
            raise ValueError("停笔静态来源身份、标签或划分不符")
        seen.add(original)
        if file_record(Path(original))["sha256"] != row["original_sha256"]:
            raise ValueError("停笔静态原图SHA不符")
        if file_record(image)["sha256"] != row["image_sha256"] or pixel_hash(image) != row["pixel_sha256"]:
            raise ValueError("停笔静态产品图像或像素SHA不符")
        pixels[row["pixel_sha256"]].add((row["split"], row["label"]))
    additions = {split: [] for split in datasets}
    excluded, isolated, counts = [], [], Counter()
    for row in rows:
        split, label = row["split"], row["label"]
        # 来源已因保留诊断或跨划分冲突隔离时，换一种渲染也不能恢复其监督资格。
        if str(Path(row["original"]).resolve()) in (excluded_origins or set()):
            isolated.append(row["sample_id"])
            continue
        # 新视图与已有任意划分/异标签发生精确像素冲突时只隔离新视图，原始保留集不动。
        if len(pixels[row["pixel_sha256"]]) != 1:
            excluded.append(row["sample_id"])
            continue
        source = accepted[str(Path(row["original"]).resolve())][2]
        additions[split].append(((directory / row["image"], label), source + "/product_static"))
        counts[split] += 1
    result = {}
    for split, data in datasets.items():
        result[split] = ImageDataset(data.records + [record for record, _ in additions[split]], data.transform,
                                    data.sources + [source for _, source in additions[split]])
    return result, {"directory": str(directory.resolve()), "manifest": file_record(directory / "manifest.json"),
                    "added_views": dict(counts), "excluded_pixel_conflicts": excluded,
                    "excluded_originals": isolated,
                    "kind": "同一原样本的产品输入表示，不增加独立手绘人数或母图数量。"}
