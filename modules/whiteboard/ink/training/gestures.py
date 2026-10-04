"""读取真实手势分类包；全部速度与重复跟随书写者划分，不重分测试用户。"""

import json
from pathlib import Path

from ..dataset.classification.acquire import file_record
from ..dataset.classification.schema import LABELS


def load_gesture_records(directory: Path) -> tuple[dict, dict]:
    """完整校验手势数据后返回三个划分的图像记录及来源元数据；不兼容数据报错。"""
    from ..dataset.gestures.generate import validate_dataset
    validate_dataset(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["classes"] != list(LABELS):
        raise ValueError("手势数据类别顺序与模型不一致")
    records, writers, identifiers = {}, {}, {}
    for split in ("train", "val", "test"):
        records[split], writers[split], identifiers[split] = [], set(), []
        for line in (directory / f"{split}.jsonl").read_text().splitlines():
            row = json.loads(line)
            sample = row["sample"]
            if sample["split"] != split or sample["label_status"] != "dataset_protocol":
                raise ValueError("真实手势划分或监督类型不符")
            path = (directory / row["image"]).resolve()
            if not path.is_relative_to(directory.resolve()):
                raise ValueError("手势图片越出数据目录")
            records[split].append((path, LABELS.index(sample["label"])))
            writers[split].add(sample["provenance"]["writer_id"])
            identifiers[split].append(sample["sample_id"])
        if not records[split]:
            raise ValueError("手势划分不能为空")
    if any(writers[a] & writers[b] for a, b in (("train", "val"), ("train", "test"), ("val", "test"))):
        raise ValueError("同一书写者跨划分")
    metadata = {"directory": str(directory.resolve()), "manifest": file_record(directory / "manifest.json"),
                "license": manifest["license"], "writers": {k: sorted(v) for k, v in writers.items()},
                "counts": {k: len(v) for k, v in records.items()}, "sample_ids": identifiers,
                "limitations": manifest.get("limitations", [])}
    return records, metadata
