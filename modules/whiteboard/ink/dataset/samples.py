"""从共享目标组生成配对；组间隔离、几何上下文和局部引用均在源头明确。"""

import hashlib
import math
import random
from typing import Iterator

from .geometry import FAMILIES, Geometry, Path, make_geometry, perturb, transform
from .schema import Input, KeepTarget, ReplaceTarget, Sample, Stroke, GENERATOR_VERSION, validate_sample

VARIANTS = ("keep", "jitter", "drift", "endpoint", "mixed", "retrace", "fragment", "keep")


def _digest(*parts: object) -> str:
    return hashlib.sha256("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def _random(*parts: object) -> random.Random:
    return random.Random(int(_digest(*parts), 16))


def split_for_group(group_id: str) -> str:
    """由组 ID 稳定选择 80/10/10 概率划分；增减组数不改变已有组的归属。"""
    bucket = int(_digest("split", group_id)[:16], 16) % 100
    return "train" if bucket < 80 else "val" if bucket < 90 else "test"


def _context(rng: random.Random) -> list[Path]:
    paths: list[Path] = []
    # 近邻和远邻都保留；上下文家族独立抽样，不能总靠位置判断是否修改。
    for index in range(rng.randint(1, 3)):
        shape = make_geometry(rng.choice(FAMILIES), rng)
        center = (rng.uniform(-1.8, 1.8), rng.uniform(-1.8, 1.8))
        paths.extend(transform(shape.paths, rng.uniform(0, math.tau), rng.uniform(.35, 1.45), center))
        if index == 0 and rng.random() < .5:
            paths.extend(transform(make_geometry("double_line", rng).paths, rng.uniform(0, math.tau),
                                   rng.uniform(.35, 1.45), (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5))))
    return paths


def _corrupt(paths: list[Path], selected: list[int], kind: str,
             severity: float, rng: random.Random) -> tuple[list[Path], list[int]]:
    result: list[Path] = []
    affected: list[int] = []
    for index, path in enumerate(paths):
        if index not in selected:
            result.append(path)
            continue
        start = len(result)
        if kind == "retrace":
            for _ in range(rng.randint(2, 3)):
                result.append(perturb(path, "mixed", severity, rng))
        elif kind == "fragment":
            cut = rng.randint(max(2, len(path) // 3), min(len(path) - 3, 2 * len(path) // 3))
            # 两片完整覆盖同一路径，端点共享；不捏造尚未绘制的缺失部分。
            distorted = perturb(path, "jitter", severity, rng)
            result.extend([distorted[:cut + 1], distorted[cut:]])
        elif kind == "keep":
            result.append(path)
        else:
            result.append(perturb(path, kind, severity, rng))
        affected.extend(range(start, len(result)))
    return result, affected


def _vary_sampling(path: Path, rng: random.Random) -> Path:
    result = [path[0]]
    for a, b in zip(path, path[1:]):
        if rng.random() < .12:
            fraction = rng.uniform(.2, .8)
            result.append((round(a[0] + fraction * (b[0] - a[0]), 5),
                           round(a[1] + fraction * (b[1] - a[1]), 5)))
        result.append(b)
    return result


def _presentation(paths: list[Path], affected: list[int], focus: int,
                  rng: random.Random) -> tuple[Input, list[str]]:
    identifiers = [f"s-{value:08x}" for value in rng.sample(range(2 ** 32), len(paths))]
    strokes: list[Stroke] = []
    for identifier, path in zip(identifiers, paths):
        sampled = _vary_sampling(path, rng)
        ordered = sampled if rng.random() < .5 else list(reversed(sampled))
        strokes.append({"id": identifier, "points": [[x, y] for x, y in ordered]})
    rng.shuffle(strokes)
    source_ids = [identifiers[index] for index in affected]
    rng.shuffle(source_ids)
    return {"focus_stroke_id": identifiers[focus], "strokes": strokes}, source_ids


def _make_variant(seed: int, group_index: int, variant_index: int, group_id: str,
                  geometry: Geometry, context: list[Path]) -> Sample:
    rng = _random(seed, group_index, variant_index, "variant")
    kind = VARIANTS[variant_index]
    severity = 0.0 if kind == "keep" else round(rng.uniform(.004, .025), 6)
    # 结构合并一次只选一个完整路径，避免顺手把正确的相邻双线合并。
    count = 1 if kind in ("retrace", "fragment") else rng.randint(1, len(geometry.paths))
    selected = rng.sample(range(len(geometry.paths)), count)
    source_paths, affected = _corrupt(geometry.paths, selected, kind, severity, rng)
    source_paths.extend(context)
    desired = [geometry.paths[index] for index in selected]
    angle, scale = rng.uniform(0, math.tau), rng.uniform(35, 180)
    offset = (rng.uniform(-300, 300), rng.uniform(-300, 300))
    source_paths = transform(source_paths, angle, scale, offset)
    desired = transform(desired, angle, scale, offset)
    features, source_ids = _presentation(source_paths, affected, rng.choice(affected), rng)
    target: KeepTarget | ReplaceTarget
    if kind == "keep":
        target = {"action": "keep"}
    else:
        rng.shuffle(desired)
        target = {"action": "replace", "source_stroke_ids": source_ids,
                  "strokes": [{"points": [[x, y] for x, y in
                                           (path if rng.random() < .5 else list(reversed(path)))]}
                              for path in desired]}
    sample: Sample = {
        "schema_version": 1,
        "sample_id": "sample-" + _digest(seed, group_index, variant_index, "sample")[:24],
        "group_id": group_id,
        "input": features,
        "target": target,
        "annotation": {"status": "generated"},
        "provenance": {"kind": "synthetic", "generator_version": GENERATOR_VERSION,
                       "seed": seed, "group_index": group_index, "variant_index": variant_index,
                       "family": geometry.family, "primitive": geometry.primitive,
                       "corruption": kind, "severity": severity},
    }
    validate_sample(sample)
    return sample


def generate_group(seed: int, group_index: int) -> list[Sample]:
    """返回同源目标的八个变体；负数或布尔参数抛出 ValueError，输出不含动作特征。"""
    if any(type(value) is not int or value < 0 for value in (seed, group_index)):
        raise ValueError("seed 和 group_index 必须是非负整数")
    rng = _random(seed, group_index, "geometry")
    # 每个家族每四组保留一个严格规则子型，保证小批次也包含圆和正方形。
    regular = (group_index // len(FAMILIES)) % 4 == 0
    geometry = make_geometry(FAMILIES[group_index % len(FAMILIES)], rng, regular)
    geometry = Geometry(geometry.family, transform(geometry.paths, rng.uniform(0, math.tau),
                        rng.uniform(.5, 1.3), (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5))),
                        geometry.primitive)
    context = _context(rng)
    group_id = "group-" + _digest(seed, group_index, "group")[:24]
    return [_make_variant(seed, group_index, variant_index, group_id, geometry, context)
            for variant_index in range(len(VARIANTS))]


def iter_samples(seed: int, groups: int) -> Iterator[tuple[str, Sample]]:
    """逐组产生划分名和样本，不保存全量数据；非法组数抛出 ValueError。"""
    if type(groups) is not int or groups < 1:
        raise ValueError("groups 必须是正整数")
    for group_index in range(groups):
        for sample in generate_group(seed, group_index):
            yield split_for_group(sample["group_id"]), sample
