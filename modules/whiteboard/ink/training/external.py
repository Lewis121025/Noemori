"""读取来源专用验证器发布的真实图形/字符包，不把任意JSON标签当监督。"""

from collections import Counter, defaultdict
import json
from pathlib import Path

from ..dataset.classification.acquire import file_record
from ..dataset.classification.schema import LABELS
from .data import ImageDataset
from .native_images import pixel_hash


def _validate(directory: Path, dataset: str) -> None:
    if dataset == "hds-real-shapes-v1":
        from ..dataset.real_shapes.package import validate_dataset
        validate_dataset(directory)
    elif dataset == "quickdraw-real-shapes-v1":
        from ..dataset.real_shapes.quickdraw import validate_quickdraw
        validate_quickdraw(directory)
    elif dataset == "whiteboard-handwriting-negatives-v1":
        from ..dataset.handwriting.package import validate_dataset
        validate_dataset(directory)
    elif dataset == "shape-boundary-review-v1":
        from ..dataset.boundary.package import validate_dataset
        validate_dataset(directory)
    elif dataset == "chinese-handwriting-negatives-v1":
        from ..dataset.chinese.package import validate_dataset
        validate_dataset(directory)
    else:
        raise ValueError("外部包未经来源专用验证器支持，拒绝接受监督标签")


def load_external_packages(directories: list[Path]) -> dict:
    """完整核验固定格式真实包；只返回accepted的监督划分，候选/review包不得混入。"""
    records = {split: [] for split in ("train", "val", "test")}
    sources = {split: [] for split in records}
    metadata, seen, groups, pixels, vectors = [], set(), {}, {}, {}
    roots = [directory.resolve() for directory in directories]
    if len(set(roots)) != len(roots):
        raise ValueError("外部数据包目录重复")
    for directory in roots:
        manifest = json.loads((directory / "manifest.json").read_text())
        dataset = manifest.get("dataset")
        _validate(directory, dataset)
        if manifest.get("classes") != list(LABELS):
            raise ValueError("外部数据包类别顺序不符")
        counts = Counter()
        for split in records:
            with (directory / f"{split}.jsonl").open() as handle:
                for line in handle:
                    row = json.loads(line)
                    if (row["split"] != split or row["label"] not in LABELS
                            or row["annotation_status"] != "accepted"):
                        raise ValueError("外部监督划分或接受状态非法")
                    identity = (dataset, row["sample_id"])
                    if identity in seen:
                        raise ValueError("外部监督身份重复")
                    seen.add(identity)
                    # 同一个QuickDraw原key在不同发布版本中仍是同一个来源，版本名不能隔离泄漏。
                    domain = "quickdraw" if dataset in ("quickdraw-real-shapes-v1", "shape-boundary-review-v1") else dataset
                    group = (domain, row["group_id"])
                    if groups.setdefault(group, split) != split:
                        raise ValueError("外部来源组跨划分")
                    path = (directory / row["image"]).resolve()
                    if not path.is_relative_to(directory):
                        raise ValueError("外部图像路径越出来源包")
                    source = ("hds" if dataset == "hds-real-shapes-v1" else
                              "quickdraw_boundary" if dataset == "shape-boundary-review-v1" else
                              "chinese_numbers" if dataset == "chinese-handwriting-negatives-v1" else
                              "quickdraw" if dataset == "quickdraw-real-shapes-v1" else row["provenance"]["source"])
                    sampling_source = f"{source}/{row['annotation_kind']}"
                    records[split].append((path, LABELS.index(row["label"])))
                    sources[split].append(sampling_source)
                    pixels[str(path)] = row["pixel_sha256"]
                    if row.get("paths"):
                        vectors[str(path)] = row["paths"]
                    counts[split, row["label"], sampling_source] += 1
        metadata.append({"directory": str(directory), "dataset": dataset,
                         "manifest": file_record(directory / "manifest.json"), "source_counts": manifest["counts"],
                         "accepted": [{"split": split, "label": label, "source": source, "count": count}
                                      for (split, label, source), count in sorted(counts.items())],
                         "limitations": manifest.get("limitations", [])})
    return {"records": records, "sources": sources, "metadata": metadata, "pixels": pixels, "vectors": vectors}


def load_external_native(directory: Path, external: dict) -> dict:
    """把真实原矢量替换为产品渲染输入；纯栅格来源保留原图，不增加原始记录数。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    expected = {row["directory"]: row["manifest"] for row in external["metadata"]}
    actual = {row["directory"]: row["manifest"] for row in manifest["sources"]}
    vector_roots = {root for root in expected if any(Path(path).is_relative_to(root) for path in external["vectors"])}
    if (any(actual.get(root) != expected[root] for root in vector_roots)
            or any(actual[root] != expected[root] for root in actual.keys() & expected.keys())
            or file_record(directory / "records.jsonl") != manifest["records"]):
        raise ValueError("外部端侧视图与来源快照不符")
    indexed = {}
    for row in map(json.loads, (directory / "records.jsonl").read_text().splitlines()):
        if row["original"] in indexed:
            raise ValueError("外部端侧视图原始身份重复")
        indexed[row["original"]] = row
    removed = []
    for split in ("train", "val", "test"):
        records, sources = [], []
        for (path, label), source in zip(external["records"][split], external["sources"][split]):
            if str(path) not in external["vectors"]:
                records.append((path, label))
                sources.append(source)
                continue
            row = indexed.get(str(path))
            if (row is None or row["label"] != LABELS[label] or row["split"] != split
                    or file_record(path)["sha256"] != row["original_sha256"]):
                raise ValueError("外部矢量端侧视图缺失或标签/划分不符")
            target = (directory / row["image"]).resolve()
            if (not target.is_relative_to(directory.resolve()) or file_record(target)["sha256"] != row["image_sha256"]
                    or pixel_hash(target) != row["pixel_sha256"]):
                raise ValueError("外部端侧图像散列或路径不符")
            if row["exclude_native"] or row["exclude_original"]:
                removed.append({"path": str(path), "split": split, "reason": "reserved_or_cross_split_pixel_duplicate"})
                continue
            records.append((target, label))
            sources.append(source)
            external["pixels"][str(target)] = row["pixel_sha256"]
        external["records"][split], external["sources"][split] = records, sources
    external["native"] = {"directory": str(directory.resolve()), "manifest": file_record(directory / "manifest.json"),
                           "replacement_policy": "real_vectors_only_raster_sources_preserved", "removed": removed,
                           "snapshot_scope": "vector_sources_required_raster_sources_verified_by_original_reader"}
    return external


def merge_external(datasets: dict, external: dict, reserved_pixels: set[str] | None = None) -> tuple[dict, dict]:
    """追加外部数据并隔离跨划分同像素；全部冲突副本移除，不改变任何原始分组划分。"""
    combined, by_pixel, digest_cache = {}, defaultdict(set), dict(external["pixels"])
    for split, data in datasets.items():
        combined[split] = ImageDataset(data.records + external["records"][split], data.transform,
                                       data.sources + external["sources"][split])
        for path, _ in combined[split].records:
            key = str(path.resolve())
            if key not in digest_cache:
                digest_cache[key] = pixel_hash(path)
            by_pixel[digest_cache[key]].add(split)
    conflicts = {digest for digest, splits in by_pixel.items() if len(splits) > 1}
    removed, retained = [], {}
    for split, data in combined.items():
        records, sources = [], []
        for (path, label), source in zip(data.records, data.sources):
            digest = digest_cache[str(path.resolve())]
            reserved = split in ("train", "val") and digest in (reserved_pixels or set())
            if digest in conflicts or reserved:
                removed.append({"path": str(path), "split": split, "source": source,
                                "pixel_sha256": digest, "reason": "reserved_diagnostic" if reserved else "cross_split_pixel_duplicate"})
                continue
            records.append((path, label))
            sources.append(source)
        retained[split] = ImageDataset(records, data.transform, sources)
    return retained, {"cross_split_pixel_groups": len(conflicts), "removed": removed}


def source_counts(data: ImageDataset) -> list[dict]:
    """按类别和来源报告实际输入视图数；这些数量不能冒充独立原始手绘数。"""
    counts = Counter((LABELS[label], source) for (_, label), source in zip(data.records, data.sources))
    return [{"label": label, "source": source, "views": count} for (label, source), count in sorted(counts.items())]
