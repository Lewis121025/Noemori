"""将外部矢量目标变为配对；只复用首版的几何偏差与表现随机化，不修改首版。"""

from dataclasses import dataclass
import math
from pathlib import Path as FilePath
from typing import Iterator

from ..geometry import Path, transform
from ..samples import VARIANTS, _corrupt, _digest, _presentation, _random
from ..schema import KeepTarget, ReplaceTarget
from .schema import GENERATOR_VERSION, TablerSample, validate_sample
from .sources import REVISION, source_assignment, verify_sources
from .svg import parse_svg_file


@dataclass(frozen=True)
class SourceGeometry:
    """固定来源的规范路径和导入记录；split 在来源族层面分配，所有增强继承。"""

    filename: str
    sha256: str
    family: str
    split: str
    paths: list[Path]
    original_shapes: int
    excluded: list[dict[str, object]]


def load_geometries(directory: FilePath) -> list[SourceGeometry]:
    """核对来源后导入全部图形并统一等比归一化；任何失败抛错，不悄悄缩小数据来源。"""
    geometries: list[SourceGeometry] = []
    for record in verify_sources(directory):
        filename = str(record["file"])
        imported = parse_svg_file(directory / filename)
        xs = [x for path in imported.paths for x, _ in path]
        ys = [y for path in imported.paths for _, y in path]
        extent = max(max(xs) - min(xs), max(ys) - min(ys))
        if extent <= 0:
            raise ValueError(f"素材缺少空间范围：{filename}")
        scale = 2 / extent
        offset = (-(max(xs) + min(xs)) * scale / 2, -(max(ys) + min(ys)) * scale / 2)
        family, split = source_assignment(filename)
        geometries.append(SourceGeometry(filename, str(record["sha256"]), family, split,
                                         transform(imported.paths, 0, scale, offset),
                                         imported.shape_count, imported.excluded))
    return sorted(geometries, key=lambda geometry: geometry.filename)


def _make_sample(source: SourceGeometry, context: SourceGeometry, seed: int,
                 augmentation: int, variant: int) -> TablerSample:
    rng = _random("tabler", seed, source.filename, augmentation, variant)
    core = transform(source.paths, rng.uniform(0, math.tau), rng.uniform(.5, 1.3),
                     (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5)))
    surroundings = transform(context.paths, rng.uniform(0, math.tau), rng.uniform(.5, 1.3),
                             (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5)))
    corruption = VARIANTS[variant]
    severity = 0.0 if corruption == "keep" else round(rng.uniform(.004, .025), 6)
    count = 1 if corruption in ("fragment", "retrace") else rng.randint(1, min(len(core), 4))
    selected = rng.sample(range(len(core)), count)
    paths, affected = _corrupt(core, selected, corruption, severity, rng)
    paths.extend(surroundings)
    desired = [core[index] for index in selected]
    angle, scale = rng.uniform(0, math.tau), rng.uniform(35, 180)
    offset = (rng.uniform(-300, 300), rng.uniform(-300, 300))
    paths, desired = transform(paths, angle, scale, offset), transform(desired, angle, scale, offset)
    features, source_ids = _presentation(paths, affected, rng.choice(affected), rng)
    target: KeepTarget | ReplaceTarget
    if corruption == "keep":
        target = {"action": "keep"}
    else:
        rng.shuffle(desired)
        target = {"action": "replace", "source_stroke_ids": source_ids,
                  "strokes": [{"points": [[x, y] for x, y in (path if rng.random() < .5 else list(reversed(path)))]}
                              for path in desired]}
    sample: TablerSample = {
        "schema_version": 1,
        "sample_id": "tabler-" + _digest(seed, source.filename, augmentation, variant)[:24],
        "group_id": f"tabler-{source.family}",
        "input": features, "target": target, "annotation": {"status": "generated"},
        "provenance": {"kind": "synthetic", "generator_version": GENERATOR_VERSION,
                       "source_revision": REVISION, "source_file": source.filename,
                       "source_sha256": source.sha256, "source_family": source.family,
                       "context_source_files": [context.filename], "seed": seed,
                       "augmentation_index": augmentation, "variant_index": variant,
                       "corruption": corruption, "severity": severity},
    }
    validate_sample(sample)
    return sample


def iter_samples(geometries: list[SourceGeometry], seed: int, augmentations: int) -> Iterator[tuple[str, TablerSample]]:
    """逐素材输出所有增强，背景只来自本划分；非法配置或缺少同划分背景时报 ValueError。"""
    if type(seed) is not int or seed < 0 or type(augmentations) is not int or augmentations < 1:
        raise ValueError("seed 必须非负，augmentations 必须为正整数")
    for source in geometries:
        candidates = [geometry for geometry in geometries if geometry.split == source.split
                      and geometry.filename != source.filename]
        if not candidates:
            raise ValueError(f"{source.split} 缺少独立背景素材")
        for augmentation in range(augmentations):
            context_rng = _random("tabler-context", seed, source.filename, augmentation)
            context = context_rng.choice(candidates)
            for variant in range(len(VARIANTS)):
                yield source.split, _make_sample(source, context, seed, augmentation, variant)
