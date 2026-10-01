"""流式数据生产与完整性核验；只有验证完成的目录才会发布到用户指定位置。"""

import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import tempfile

from .geometry import FAMILIES
from .preview import write_preview
from .samples import VARIANTS, iter_samples, split_for_group
from .schema import CORRUPTIONS, GENERATOR_VERSION, Sample, validate_sample

SPLITS = ("train", "val", "test")
LIMITATIONS = [
    "这是自有程序生成的合成几何配对，不是人工确认的真实手绘修正数据，也没有使用外部图形素材。",
    "训练与测试共享生成器分布，合成测试指标不能证明真实手绘或未见图形类别的泛化。",
    "相关抖动、慢漂移及端点扰动是人为几何分布，尚未用真实设备与用户数据校准。",
    "重复描画及分段合并的目标来自生成约定；仅凭几何不能排除有意双线或有意分笔的其他解释。",
    "每个样本表示完整可见部件刚完成时的快照，不包含未来笔画、缺失形状补全或中途绘制状态。",
    "首批覆盖合并与坐标调整，契约支持拆分但本批没有拆分监督样本。",
    "未覆盖文字、数学公式、复杂图表语义、压力线宽、孤立点、擦除和删除操作。",
    "所选多笔框、箭头与双线只表达有限结构；全局旋转与缩放保持输入目标一致，不能视为偏差。",
    "路径是离散折线，目标间的笔画顺序与路径方向没有语义；训练损失必须处理相应等价性。",
    "上下文为随机组合的完整图形，存在遮挡与近邻，尚不代表真实白板的语义布局。",
    "首批 replace 样本都包含 focus；契约允许只修改相关旧笔画，但该情形尚未合成。",
]


def _hash(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _empty_counts() -> dict[str, Counter[str]]:
    return {split: Counter() for split in SPLITS}


def _write_samples(destination: Path, seed: int, groups: int) -> dict[str, object]:
    counts, family_counts, corruption_counts = Counter(), _empty_counts(), _empty_counts()
    primitive_counts = _empty_counts()
    group_counts = {split: set() for split in SPLITS}
    representatives: dict[tuple[str, str], Sample] = {}
    total_bytes = 0
    with ExitStack() as stack:
        handles = {split: stack.enter_context((destination / f"{split}.jsonl").open("w", encoding="utf-8"))
                   for split in SPLITS}
        for split, sample in iter_samples(seed, groups):
            line = json.dumps(sample, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
            total_bytes += len(line.encode("utf-8"))
            if total_bytes > 145_000_000:
                raise ValueError("数据超过首批 145 MB 配对预算，请减少组数")
            handles[split].write(line)
            counts[split] += 1
            group_counts[split].add(sample["group_id"])
            family, corruption = sample["provenance"]["family"], sample["provenance"]["corruption"]
            family_counts[split][family] += 1
            primitive_counts[split][sample["provenance"]["primitive"]] += 1
            corruption_counts[split][corruption] += 1
            representatives.setdefault((sample["provenance"]["primitive"], corruption), sample)
    primitive_order = [primitive for family in FAMILIES
                       for primitive in {"ellipse": ("circle", "ellipse"), "frame": ("square", "rectangle")}.get(family, (family,))]
    ordered_preview = [representatives[(primitive, corruption)] for primitive in primitive_order for corruption in CORRUPTIONS
                       if (primitive, corruption) in representatives]
    write_preview(ordered_preview, destination / "preview.html")
    return {"samples": sum(counts.values()), "splits": {split: counts[split] for split in SPLITS},
            "groups": {split: len(group_counts[split]) for split in SPLITS},
            "families": {split: dict(sorted(value.items())) for split, value in family_counts.items()},
            "primitives": {split: dict(sorted(value.items())) for split, value in primitive_counts.items()},
            "corruptions": {split: dict(sorted(value.items())) for split, value in corruption_counts.items()},
            "preview_samples": len(ordered_preview)}


def _manifest(destination: Path, seed: int, groups: int, counts: dict[str, object]) -> dict[str, object]:
    names = [f"{split}.jsonl" for split in SPLITS] + ["preview.html"]
    return {
        "schema_version": 1, "dataset": "noemori-whiteboard-geometry-v1", "generator_version": GENERATOR_VERSION,
        "config": {"seed": seed, "groups": groups, "variants_per_group": len(VARIANTS)},
        "coordinate_system": "world_xy_y_down",
        "feature_contract": {"input_only": True, "fields": ["focus_stroke_id", "strokes.id", "strokes.points"],
                             "excluded": ["time", "pressure", "velocity", "family", "primitive", "corruption", "provenance"]},
        "primitive_policy": {"ellipse": "每四个独立目标组中一个严格圆，其余为非圆椭圆",
                             "frame": "每四个独立目标组中一个严格正方形，其余为非正方形矩形",
                             "measured_sample_counts": "counts.primitives；每组包含八个变体"},
        "target_contract": {"actions": ["keep", "replace"], "focus_must_be_in_replace_scope": False,
                            "untouched_input_strokes_preserved": True, "variable_path_and_point_counts": True},
        "split_policy": {"unit": "group_id", "method": "sha256('split|' + group_id)[:16] % 100",
                         "buckets": {"train": [0, 79], "val": [80, 89], "test": [90, 99]},
                         "family_disjoint": False, "independent_of_total_groups": True},
        "counts": counts,
        "files": {name: {"sha256": _hash(destination / name), "bytes": (destination / name).stat().st_size}
                  for name in names},
        "generator_sources": {path.name: _hash(path) for path in sorted(Path(__file__).parent.glob("*.py"))},
        "limitations": LIMITATIONS,
    }


def _scan_samples(directory: Path) -> dict[str, object]:
    seen_ids: set[str] = set()
    group_splits: dict[str, str] = {}
    group_variants: dict[str, set[int]] = {}
    counts, family_counts, corruption_counts = Counter(), _empty_counts(), _empty_counts()
    primitive_counts = _empty_counts()
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                try:
                    sample = json.loads(line)
                    validate_sample(sample)
                except (ValueError, TypeError) as error:
                    raise ValueError(f"{split}.jsonl:{line_number}: {error}") from error
                sample_id, group_id = sample["sample_id"], sample["group_id"]
                if sample_id in seen_ids:
                    raise ValueError(f"样本 ID 重复：{sample_id}")
                seen_ids.add(sample_id)
                if split_for_group(group_id) != split or group_splits.get(group_id, split) != split:
                    raise ValueError(f"目标组跨划分或划分错误：{group_id}")
                group_splits[group_id] = split
                variants = group_variants.setdefault(group_id, set())
                variant = sample["provenance"]["variant_index"]
                if variant in variants or not 0 <= variant < len(VARIANTS):
                    raise ValueError(f"目标组变体重复或越界：{group_id}")
                variants.add(variant)
                counts[split] += 1
                family_counts[split][sample["provenance"]["family"]] += 1
                primitive_counts[split][sample["provenance"]["primitive"]] += 1
                corruption_counts[split][sample["provenance"]["corruption"]] += 1
    if any(len(variants) != len(VARIANTS) for variants in group_variants.values()):
        raise ValueError("目标组缺少变体")
    return {"samples": len(seen_ids), "splits": {split: counts[split] for split in SPLITS},
            "groups": {split: sum(value == split for value in group_splits.values()) for split in SPLITS},
            "families": {split: dict(sorted(value.items())) for split, value in family_counts.items()},
            "primitives": {split: dict(sorted(value.items())) for split, value in primitive_counts.items()},
            "corruptions": {split: dict(sorted(value.items())) for split, value in corruption_counts.items()}}


def validate_dataset(directory: Path) -> dict[str, object]:
    """流式核验样本、组隔离、数量与文件散列；返回实测统计，损坏数据抛出 ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1 or manifest.get("generator_version") != GENERATOR_VERSION:
        raise ValueError("数据集 manifest 版本不符")
    for name in [f"{split}.jsonl" for split in SPLITS] + ["preview.html"]:
        declared = manifest["files"][name]
        path = directory / name
        if path.stat().st_size != declared["bytes"] or _hash(path) != declared["sha256"]:
            raise ValueError(f"文件散列或大小不符：{name}")
    actual = _scan_samples(directory)
    for key, value in actual.items():
        if value != manifest["counts"][key]:
            raise ValueError(f"manifest 数量不符：{key}")
    if sum(actual["groups"].values()) != manifest["config"]["groups"]:
        raise ValueError("组数与生成配置不符")
    return actual


def generate_dataset(destination: Path, seed: int = 20260929, groups: int = 2000) -> dict[str, object]:
    """原子发布数据、预览和 manifest；非空目标或非法参数抛出 ValueError，I/O 错误原样传播。"""
    if type(seed) is not int or seed < 0 or type(groups) is not int or groups < 1:
        raise ValueError("seed 必须为非负整数，groups 必须为正整数")
    if destination.is_symlink() or (destination.exists() and
                                   (not destination.is_dir() or any(destination.iterdir()))):
        raise ValueError("拒绝覆盖已有非空目录、文件或符号链接")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".geometry-build-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "dataset"
        staging.mkdir()
        counts = _write_samples(staging, seed, groups)
        manifest = _manifest(staging, seed, groups, counts)
        _write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
        os.replace(staging, destination)
    return manifest


def main() -> None:
    """解析生成/核验 CLI；成功打印计数，配置或数据错误交由 argparse 返回非零退出码。"""
    parser = argparse.ArgumentParser(description="生成和核验白板几何修正合成数据")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate", help="生成第一批可复现配对")
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--groups", type=int, default=2000)
    generate.add_argument("--seed", type=int, default=20260929)
    validate = commands.add_parser("validate", help="流式核验已有数据及 manifest")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "generate":
            result = generate_dataset(args.output, args.seed, args.groups)["counts"]
        else:
            result = validate_dataset(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))
