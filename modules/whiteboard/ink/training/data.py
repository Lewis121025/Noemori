"""读取分类图像；未经复核的提示标签不进入监督训练，预处理保留几何长宽比。"""

import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image
import torch
from torch.utils.data import Dataset, WeightedRandomSampler
from torchvision import transforms

from ..dataset.classification.schema import LABELS, validate_sample


def image_transform(mean: tuple[float, ...], std: tuple[float, ...], training: bool):
    """构造归一化变换；旋转先扩展方形画布再等比缩回，不裁掉箭翼或扭曲长宽比。"""
    operations = []
    if training:
        operations.extend([
            transforms.RandomRotation(180, expand=True, fill=255,
                                      interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.Resize(224, interpolation=transforms.InterpolationMode.BILINEAR),
        ])
        operations.append(transforms.RandomAffine(
            degrees=0, translate=(0.025, 0.025), scale=(0.85, 1.0), fill=255,
            interpolation=transforms.InterpolationMode.BILINEAR))
    return transforms.Compose([*operations, transforms.ToTensor(), transforms.Normalize(mean, std)])


class ImageDataset(Dataset):
    """已由各来源读取器校验过的静态图像；不同来源共用完全一致的像素预处理。"""

    def __init__(self, records: list[tuple[Path, int]], transform, sources: list[str] | None = None):
        """保存已验证的图像路径和类别；空数据或非法类别索引抛 ValueError。"""
        if not records or any(type(label) is not int or not 0 <= label < len(LABELS) for _, label in records):
            raise ValueError("图像记录不能为空且必须使用合法类别索引")
        self.records = records
        self.transform = transform
        self.sources = sources if sources is not None else ["unspecified"] * len(records)
        if len(self.sources) != len(records) or any(not source for source in self.sources):
            raise ValueError("图像来源分组与样本数量不符")
        self.counts = {label: sum(index == i for _, index in records) for i, label in enumerate(LABELS)}

    def __len__(self) -> int:
        """返回当前划分的完整图形数。"""
        return len(self.records)

    def __getitem__(self, index: int):
        """返回规范化图像张量和类别索引；尺寸或模式不符抛 ValueError。"""
        path, label = self.records[index]
        with Image.open(path) as image:
            if image.mode != "RGB" or image.size != (224, 224):
                raise ValueError("训练输入必须为 224×224 RGB")
            tensor = self.transform(image)
        return tensor, label


class ShapeDataset(ImageDataset):
    """一个合成划分及显式复核补充；构造前由发布器校验完整数据集及图像散列。"""

    def __init__(self, directory: Path, split: str, transform, extra_records: list | None = None):
        """读取合成划分及经过独立复核入口验证的补充；测试划分禁止加入补充。"""
        if split not in ("train", "val", "test"):
            raise ValueError("待复核数据不得用于训练或正式评测")
        self.directory = directory.resolve()
        self.records = []
        sources = []
        source_file = directory / "coverage-source-groups.jsonl"
        source_groups = {}
        if source_file.exists():
            for entry in map(json.loads, source_file.read_text().splitlines()):
                if (entry["sample_id"] in source_groups or entry["source"] != "synthetic_boundary"
                        or not entry["group_id"]):
                    raise ValueError("合成边界来源身份无效")
                source_groups[entry["sample_id"]] = entry
        counts = [0] * len(LABELS)
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                record = json.loads(line)
                sample = record["sample"]
                validate_sample(sample)
                if sample["split"] != split or sample["label_status"] != "synthetic":
                    raise ValueError("首轮训练只接受明确标注的合成划分")
                image_path = (self.directory / record["image"]).resolve()
                if not image_path.is_relative_to(self.directory):
                    raise ValueError("图像路径越出数据集")
                label = LABELS.index(sample["label"])
                counts[label] += 1
                self.records.append((image_path, label))
                origin = source_groups.get(sample["sample_id"])
                if origin and origin["group_id"] != sample["group_id"]:
                    raise ValueError("合成边界来源组与样本不符")
                sources.append(origin["source"] if origin else "synthetic")
        if extra_records:
            if split == "test":
                raise ValueError("补充数据不能改变保留测试集")
            for path, label in extra_records:
                if not path.is_relative_to(self.directory) or label != LABELS.index("other"):
                    raise ValueError("额外监督必须为当前数据集内的已复核负例")
                self.records.append((path, label))
                sources.append("ai_reviewed_quickdraw")
                counts[label] += 1
        if not all(counts):
            raise ValueError(f"{split} 必须覆盖所有类别，当前数量 {counts}")
        super().__init__(self.records, transform, sources)


class RetentionDataset(ImageDataset):
    """训练时标记可重放的旧来源；该标记不进入图像或部署模型。"""

    def __getitem__(self, index: int):
        """返回图像、真值及旧来源布尔标记；独立复核的新图形不采用旧模型约束。"""
        from .selection import legacy_source
        tensor, label = super().__getitem__(index)
        return tensor, label, legacy_source(self.sources[index])


def balanced_sampler(data: ImageDataset, seed: int, num_samples: int | None = None) -> WeightedRandomSampler:
    """先均衡类别，再均衡该类的来源，防止大规模字母集淹没几何或少量动物负例。"""
    counts = Counter((label, source) for (_, label), source in zip(data.records, data.sources))
    origins = Counter(label for label, _ in counts)
    weights = [1 / (origins[label] * counts[label, source])
               for (_, label), source in zip(data.records, data.sources)]
    if num_samples is not None and (type(num_samples) is not int or num_samples < 1):
        raise ValueError("均衡采样数量必须为正整数")
    return WeightedRandomSampler(weights, len(data) if num_samples is None else num_samples, replacement=True,
                                 generator=torch.Generator().manual_seed(seed))


def seed_worker(worker_id: int) -> None:
    """由 DataLoader 的固定生成器派生每个进程的随机源，避免增强不可复现。"""
    seed = torch.initial_seed() % (2 ** 32)
    random.seed(seed)
    np.random.seed(seed)
