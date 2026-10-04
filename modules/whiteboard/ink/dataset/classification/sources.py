"""从完整几何和 QuickDraw 提示标签建立分类对象；不读取旧的局部修复配对。"""

import hashlib
import json
import math
from pathlib import Path
import random
from typing import Iterator

from ..geometry import make_geometry, perturb, transform
from .schema import LABELS, Sample, content_hash, split_for_group, validate_sample

QUICKDRAW_LABELS = {"line": "line", "circle": "circle", "square": "rectangle",
                   "triangle": "triangle", "star": "other", "cat": "other"}
# 只使用已属于 train 的完整简单图标；line.svg 带端点圆圈，不能把图标名当作纯直线标签。
TABLER_LABELS = {"circle.svg": "circle", "oval.svg": "ellipse",
                 "rectangle.svg": "rectangle", "rectangle-vertical.svg": "rectangle",
                 "square.svg": "rectangle", "triangle.svg": "triangle",
                 "triangle-inverted.svg": "triangle", "arrow-up.svg": "arrow",
                 "arrow-down.svg": "arrow", "arrow-left.svg": "arrow", "arrow-right.svg": "arrow",
                 "star.svg": "other", "hexagon.svg": "other", "pentagon.svg": "other"}


def _sample(paths, label, group, split, kind, source_id, source_hash, source_label, variant=0, recognized=None) -> Sample:
    sample: Sample = {
        "schema_version": 1, "sample_id": content_hash([kind, source_id, source_hash, variant])[:32],
        "group_id": group, "split": split, "label": label,
        "label_status": "prompt_unreviewed" if kind == "quickdraw" else "synthetic",
        "paths": [[list(point) for point in path] for path in paths],
        "provenance": {"kind": kind, "source_id": source_id, "source_sha256": source_hash,
                       "source_label": source_label, "variant": variant, "recognized": recognized,
                       "license": {"procedural": "project-generated", "tabler": "MIT", "quickdraw": "CC-BY-4.0"}[kind]},
    }
    validate_sample(sample)
    return sample


def _geometry(label: str, rng: random.Random):
    if label in ("circle", "ellipse"):
        paths = make_geometry("ellipse", rng, regular=True).paths
        if label == "ellipse":
            # 首批排除近圆歧义带；后续真实标注需要单独覆盖该边界。
            ratio = rng.uniform(.35, .8)
            paths = [[(x, y * ratio) for x, y in path] for path in paths]
        return paths
    if label == "arc":
        sweep = rng.uniform(.6, 1.7) * math.pi
        return [[(math.cos(sweep * i / 63), math.sin(sweep * i / 63)) for i in range(64)]]
    if label == "triangle":
        corners = [(-1.0, 1.0), (1.0, 1.0), (rng.uniform(-.7, .7), rng.uniform(-1.2, -.5))]
        return [[(a[0] + (b[0] - a[0]) * i / 16, a[1] + (b[1] - a[1]) * i / 16)
                 for a, b in zip(corners, [*corners[1:], corners[0]]) for i in range(16)] + [corners[0]]]
    family = "frame" if label == "rectangle" else rng.choice(("wave", "double_line")) if label == "other" else label
    return make_geometry(family, rng).paths


def _variants(paths, label, group, split, kind, source_id, source_hash, source_label, rng):
    for variant, severity in enumerate((0.0, .008, .02)):
        modified = [perturb(path, "mixed", severity, rng) for path in paths] if severity else paths
        modified = transform(modified, rng.uniform(0, math.tau), rng.uniform(40, 120), (0, 0))
        yield _sample(modified, label, group, split, kind, source_id, source_hash, source_label, variant)


def synthetic_samples(seed: int, groups_per_class: int) -> Iterator[Sample]:
    """复用几何生成器输出完整对象及三种变体；先按母图分组，非法数量/seed 抛 ValueError。"""
    if type(seed) is not int or seed < 0 or type(groups_per_class) is not int or not 1 <= groups_per_class <= 10000:
        raise ValueError("seed 必须非负，每类组数必须在 1 到 10000 之间")
    for label in LABELS:
        for index in range(groups_per_class):
            group = f"classification-{seed}-{label}-{index}"
            rng = random.Random(group)
            paths = _geometry(label, rng)
            source_hash = content_hash(paths)
            yield from _variants(paths, label, group, split_for_group(group), "procedural", group,
                                 source_hash, label, rng)


def reference_samples(directory: Path, seed: int) -> Iterator[Sample]:
    """校验既有完整母图包后只导入白名单 Tabler 图标，保留旧来源组/划分；损坏来源报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != "geometry-reference-v1":
        raise ValueError("要求 geometry-reference-v1 完整母图，禁止导入局部修复配对")
    for name in ("geometries.jsonl", "LICENSE.tabler"):
        data = (directory / name).read_bytes()
        expected = manifest["files"][name]
        if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ValueError(f"母图来源散列不符：{name}")
    seen = set()
    with (directory / "geometries.jsonl").open() as handle:
        for line in handle:
            record = json.loads(line)
            name = record["name"]
            if record["source"] != "tabler" or name not in TABLER_LABELS:
                continue
            if name in seen or record["split"] != "train" or record["source_sha256"] != manifest["tabler"]["files"][name]:
                raise ValueError("Tabler 来源重复、散列或既有划分不符")
            seen.add(name)
            paths = [path["points"] for path in record["paths"]]
            rng = random.Random(f"{seed}|{record['identifier']}")
            yield from _variants(paths, TABLER_LABELS[name], record["group_id"], record["split"], "tabler",
                                 record["identifier"], record["source_sha256"], name, rng)
    if seen != set(TABLER_LABELS):
        raise ValueError("母图包缺少所需完整图标")


def quickdraw_sample(record: dict, category: str) -> Sample:
    """把完整 QuickDraw drawing 转为待复核对象；保留 recognized=false，提示词不保证画面正确。"""
    if category not in QUICKDRAW_LABELS or record.get("word") != category:
        raise ValueError("QuickDraw 提示词与下载类别不符")
    if (type(record.get("recognized")) is not bool or not isinstance(record.get("key_id"), str)
            or not record["key_id"].isdigit() or not isinstance(record.get("drawing"), list)):
        raise ValueError("QuickDraw 元数据不合法")
    paths = []
    for stroke in record["drawing"]:
        if (not isinstance(stroke, list) or len(stroke) != 2 or any(not isinstance(axis, list) for axis in stroke)
                or len(stroke[0]) != len(stroke[1])):
            raise ValueError("要求简化矢量的等长 x/y 数组")
        paths.append([list(point) for point in zip(stroke[0], stroke[1])])
    return _sample(paths, QUICKDRAW_LABELS[category], f"quickdraw-{record['key_id']}", "review", "quickdraw",
                   record["key_id"], content_hash(record), category, recognized=record["recognized"])
