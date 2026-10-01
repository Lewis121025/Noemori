"""发布和核验独立的 Tabler 合成数据包，保留上游许可及可追溯规范几何。"""

from collections import Counter
from contextlib import ExitStack
from dataclasses import asdict
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import tempfile

from ..samples import VARIANTS
from .preview import write_preview
from .samples import SourceGeometry, iter_samples, load_geometries
from .schema import GENERATOR_VERSION, TablerSample, validate_sample
from .sources import DEPENDENCY, REVISION, SOURCE_FAMILIES, source_assignment
from .svg import CURVE_TOLERANCE, MAX_SEGMENT_LENGTH

SPLITS = ("train", "val", "test")
FILES = ("train.jsonl", "val.jsonl", "test.jsonl", "preview.html", "clean-geometries.json", "LICENSE.tabler")
LIMITATIONS = [
    "40 个 MIT 图标仅扩充目标结构，不是 40 个真实手绘类别，也不代表白板完整分布。",
    "训练和测试都使用同一人工偏差生成器，仍需独立真实手绘评测。",
    "来源族阻止同一素材及显著旋转/方向变体跨划分；不同图标仍共享线、圆、角点等几何组成。",
    "与 geometry-v1 合训时存在跨来源几何重叠，Tabler 测试不能宣称未见几何类别泛化。",
    "SVG 子路径边界不是人的绘制顺序；focus 是合成的已完成笔画定位，不是真实抬笔记录。",
    "描边宽度、端帽、连接样式只用于界定中心线来源，不作为神经网络输入或修正目标。",
    "本版严格导入无填充的描边中心线，不支持文字、填充区、裁剪、蒙版、CSS、use、嵌套视口等SVG语义。",
    "曲线通过库求点并离散为折线；0.015 SVG 单位为采样探针的误差阈值，不是通用曲线误差的形式化上界。",
    "重复描画和分段合并仍有意图多解，几何输入无法单独证明合并是用户意愿。",
    "所有 replace 都包含 focus，未包含只改旧笔画、拆分、删笔、未来图形补全或真实设备偏差。",
]


def _hash(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _source_hashes() -> dict[str, str]:
    package = Path(__file__).parent
    files = sorted(package.glob("*.py"))
    files.extend(package.parent / name for name in ("geometry.py", "samples.py", "schema.py", "preview.py"))
    return {str(path.relative_to(package.parent)): _hash(path) for path in files}


def _write_samples(staging: Path, geometries: list[SourceGeometry], seed: int, augmentations: int) -> dict[str, object]:
    counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    corruption_counts = {split: Counter() for split in SPLITS}
    representatives: dict[tuple[str, str], TablerSample] = {}
    size = 0
    with ExitStack() as stack:
        handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("w", encoding="utf-8")) for split in SPLITS}
        for split, sample in iter_samples(geometries, seed, augmentations):
            text = json.dumps(sample, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n"
            size += len(text.encode("utf-8"))
            if size > 145_000_000:
                raise ValueError("配对数据超过 145MB 上限，请减少增强次数")
            handles[split].write(text)
            provenance = sample["provenance"]
            counts[split] += 1
            source_counts[provenance["source_file"]] += 1
            corruption_counts[split][provenance["corruption"]] += 1
            representatives.setdefault((provenance["source_file"], provenance["corruption"]), sample)
    write_preview(list(representatives.values()), staging / "preview.html")
    return {"samples": sum(counts.values()), "splits": dict(counts), "by_source": dict(source_counts),
            "corruptions": {split: dict(counts) for split, counts in corruption_counts.items()},
            "preview_samples": len(representatives), "source_files": len(geometries),
            "source_families": len({geometry.family for geometry in geometries}),
            "augmented_scenes": len(geometries) * augmentations}


def _make_manifest(staging: Path, sources: Path, geometries: list[SourceGeometry], seed: int,
                   augmentations: int, counts: dict[str, object]) -> dict[str, object]:
    source_manifest = json.loads((sources / "manifest.json").read_text(encoding="utf-8"))
    return {
        "schema_version": 1, "dataset": "noemori-tabler-synthetic-v1", "generator_version": GENERATOR_VERSION,
        "config": {"seed": seed, "augmentations_per_source": augmentations, "variants_per_augmentation": len(VARIANTS)},
        "dependency": DEPENDENCY, "coordinate_system": "world_xy_y_down",
        "feature_contract": {"input_only": True, "fields": ["focus_stroke_id", "strokes.id", "strokes.points"],
                             "same_as": "geometry-v1", "provenance_is_not_input": True},
        "provenance_contract": "tabler-synthetic-v1；与 geometry-v1 独立校验，不修改旧版 schema",
        "svg_import": {"library": DEPENDENCY, "curve_probe_tolerance_svg_units": CURVE_TOLERANCE,
                       "maximum_chord_length_svg_units": MAX_SEGMENT_LENGTH, "minimum_path_points": 7,
                       "normalization": "每个素材按整体包围盒居中，最长边等比缩放到2；保留内部布局",
                       "imported_files": len(geometries), "failures": [],
                       "excluded_elements": {geometry.filename: geometry.excluded for geometry in geometries if geometry.excluded}},
        "split_policy": {"unit": "source_family", "all_augmentations_together": True,
                         "context_sources_from_same_split": True, "claim": "来源族隔离；不是跨类别或跨来源泛化保证",
                         "assignments": {family: {"split": split, "files": [f"{name}.svg" for name in names]}
                                         for family, (split, names) in SOURCE_FAMILIES.items()}},
        "source": {"name": "Tabler Icons outline", "revision": REVISION, "license": "MIT",
                   "license_file": "LICENSE.tabler", "download_manifest": source_manifest},
        "counts": counts,
        "files": {name: {"bytes": (staging / name).stat().st_size, "sha256": _hash(staging / name)} for name in FILES},
        "generator_sources": _source_hashes(), "limitations": LIMITATIONS,
    }


def validate_dataset(directory: Path) -> dict[str, object]:
    """逐行检查来源、引用、同族/背景划分和变体完整性，再核对计数与散列；异常报错。"""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("generator_version") != GENERATOR_VERSION:
        raise ValueError("不是本版本的 Tabler 数据包")
    for name in FILES:
        path = directory / name
        if _hash(path) != manifest["files"][name]["sha256"] or path.stat().st_size != manifest["files"][name]["bytes"]:
            raise ValueError(f"文件完整性不符：{name}")
    seeds = manifest["config"]["seed"]
    augmentations = manifest["config"]["augmentations_per_source"]
    source_hashes = {record["file"]: record["sha256"] for record in manifest["source"]["download_manifest"]["records"]
                     if record["file"].endswith(".svg")}
    counts, source_counts = Counter(), Counter()
    corruption_counts = {split: Counter() for split in SPLITS}
    ids: set[str] = set()
    variants: dict[tuple[str, int], set[int]] = {}
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open(encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                try:
                    sample = json.loads(line)
                    validate_sample(sample)
                except (ValueError, TypeError) as error:
                    raise ValueError(f"{split}.jsonl:{number}: {error}") from error
                provenance = sample["provenance"]
                filename = provenance["source_file"]
                if source_assignment(filename)[1] != split:
                    raise ValueError(f"来源族跨划分：{filename}")
                if provenance["source_sha256"] != source_hashes[filename] or provenance["seed"] != seeds:
                    raise ValueError("来源散列或生成 seed 与 manifest 不符")
                if sample["sample_id"] in ids:
                    raise ValueError("样本 ID 重复")
                ids.add(sample["sample_id"])
                augmentation, variant = provenance["augmentation_index"], provenance["variant_index"]
                if not 0 <= augmentation < augmentations or not 0 <= variant < len(VARIANTS):
                    raise ValueError("增强或变体编号越界")
                seen = variants.setdefault((filename, augmentation), set())
                if variant in seen or provenance["corruption"] != VARIANTS[variant]:
                    raise ValueError("变体重复或偏差标签不符")
                seen.add(variant)
                counts[split] += 1
                source_counts[filename] += 1
                corruption_counts[split][provenance["corruption"]] += 1
    if set(source_counts) != set(source_hashes) or any(count != augmentations * len(VARIANTS) for count in source_counts.values()):
        raise ValueError("源素材或增强覆盖不完整")
    if any(len(seen) != len(VARIANTS) for seen in variants.values()):
        raise ValueError("增强场景缺少变体")
    result = {"samples": len(ids), "splits": dict(counts), "by_source": dict(source_counts),
              "corruptions": {split: dict(counts) for split, counts in corruption_counts.items()}}
    for key, value in result.items():
        if value != manifest["counts"][key]:
            raise ValueError(f"计数与 manifest 不符：{key}")
    return result


def generate_dataset(sources: Path, destination: Path, seed: int = 20260929, augmentations: int = 20) -> dict[str, object]:
    """导入全部固定素材并原子发布合成数据；不覆盖非空目录，不跳过导入失败项。"""
    if version("svgelements") != "1.9.6":
        raise ValueError(f"要求固定依赖 {DEPENDENCY}")
    if type(seed) is not int or seed < 0 or type(augmentations) is not int or augmentations < 1:
        raise ValueError("seed 必须非负，增强次数必须为正整数")
    if destination.is_symlink() or (destination.exists() and
                                   (not destination.is_dir() or any(destination.iterdir()))):
        raise ValueError("拒绝覆盖已有扩展数据目录")
    geometries = load_geometries(sources)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".tabler-build-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "dataset"
        staging.mkdir()
        counts = _write_samples(staging, geometries, seed, augmentations)
        _json(staging / "clean-geometries.json", [asdict(geometry) for geometry in geometries])
        shutil.copyfile(sources / "LICENSE", staging / "LICENSE.tabler")
        manifest = _make_manifest(staging, sources, geometries, seed, augmentations, counts)
        _json(staging / "manifest.json", manifest)
        validate_dataset(staging)
        os.replace(staging, destination)
    return manifest
