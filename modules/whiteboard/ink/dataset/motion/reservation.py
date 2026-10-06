"""完整来源快照及跨来源几何/像素保留索引，不读取模型或旧测试错误。"""

from collections import defaultdict
from dataclasses import dataclass, field
import json
from pathlib import Path
import re

from ..classification.acquire import file_record
from ..classification.schema import content_hash
from ..detail.reserved import pixel_hash


def _validate_source(directory, dataset):
    if dataset == "shape-classification-v1":
        from ..classification.generate import validate_dataset
        validate_dataset(directory)
    elif dataset == "gesture-classification-v1":
        from ..gestures.generate import validate_dataset
        validate_dataset(directory)
    else:
        from ...training.external import _validate
        _validate(directory, dataset)


@dataclass
class _Index:
    """一次审计共享的来源事实；缓存只减少重复I/O，不省略每个引用的SHA或标签契约。"""

    pixels: dict = field(default_factory=lambda: defaultdict(set))
    geometries: dict = field(default_factory=lambda: defaultdict(set))
    identities: set = field(default_factory=set)
    protected_pixels: set = field(default_factory=set)
    protected_geometry: set = field(default_factory=set)
    image_hashes: dict = field(default_factory=dict)
    originals: dict = field(default_factory=lambda: defaultdict(set))
    manifests: dict = field(default_factory=dict)

    def image_digest(self, image, expected_file_sha):
        key = str(image.resolve())
        if key not in self.image_hashes:
            self.image_hashes[key] = (file_record(image)["sha256"], pixel_hash(image))
        file_sha, digest = self.image_hashes[key]
        if file_sha != expected_file_sha:
            raise ValueError("motion保留来源图像SHA不符")
        return digest


def _collect_dataset(directory, index):
    manifest = json.loads((directory / "manifest.json").read_text())
    _validate_source(directory, manifest.get("dataset"))
    index.manifests[str(directory)] = file_record(directory / "manifest.json")
    files, counts = {}, {}
    for split in ("train", "val", "test", "review"):
        path = directory / f"{split}.jsonl"
        if not path.exists():
            continue
        files[path.name], counts[split] = file_record(path), 0
        with path.open() as handle:
            for line in handle:
                row = json.loads(line)
                sample = row.get("sample", row)
                image = (directory / row["image"]).resolve()
                if not image.is_relative_to(directory):
                    raise ValueError("motion保留图像路径越出来源")
                digest = index.image_digest(image, row["image_sha256"])
                if row.get("pixel_sha256", digest) != digest:
                    raise ValueError("motion保留来源像素SHA不符")
                label = sample.get("label")
                index.originals[str(image)].add((split, label, sample["sample_id"], sample["group_id"]))
                if split == "review":
                    index.protected_pixels.add(digest)
                else:
                    index.pixels[digest].add((split, label))
                if sample.get("paths"):
                    geometry = content_hash(sample["paths"])
                    if split == "review":
                        index.protected_geometry.add(geometry)
                    else:
                        index.geometries[geometry].add((split, label))
                for key in ("parent_id", "group_id"):
                    if sample.get(key):
                        index.identities.add(sample[key])
                counts[split] += 1
    parents = directory / "parents.jsonl"
    if parents.exists():
        files[parents.name] = file_record(parents)
        with parents.open() as handle:
            index.identities.update(json.loads(line)["parent_id"] for line in handle)
    reservation = directory / "reservation.json"
    if reservation.exists():
        files[reservation.name] = file_record(reservation)
        prior = json.loads(reservation.read_text())
        index.protected_pixels.update(prior.get("pixel_sha256", []))
        index.protected_geometry.update(prior.get("old_probe_clean_paths_sha256", []))
    return {"kind": "dataset", "directory": str(directory), "manifest": index.manifests[str(directory)],
            "files": files, "row_counts_by_split": counts}


def _collect_cache(directory, index):
    manifest = json.loads((directory / "manifest.json").read_text())
    records = directory / "records.jsonl"
    if file_record(records) != manifest["records"]:
        raise ValueError("motion保留端侧缓存records SHA不符")
    renderer = manifest["renderer"]
    if (type(renderer.get("bytes")) is not int or renderer["bytes"] <= 0
            or not isinstance(renderer.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", renderer["sha256"])):
        raise ValueError("motion历史端侧缓存renderer指纹非法")
    if any(index.manifests.get(s["directory"]) != s["manifest"] for s in manifest["sources"]):
        raise ValueError("motion保留端侧缓存未绑定同一已校验来源快照")
    index.protected_pixels.update(manifest.get("reserved_pixel_sha256", []))
    counts = defaultdict(int)
    with records.open() as handle:
        for line in handle:
            row = json.loads(line)
            original = Path(row["original"])
            if (row["split"], row["label"], row["sample_id"], row["group_id"]) not in index.originals.get(str(original), set()):
                raise ValueError("motion保留端侧标签、划分或来源身份不符")
            native = (directory / row["image"]).resolve()
            if not native.is_relative_to(directory):
                raise ValueError("motion保留端侧图片路径越出来源")
            digests = (index.image_digest(original, row["original_sha256"]), index.image_digest(native, row["image_sha256"]))
            if digests != (row["original_pixel_sha256"], row["pixel_sha256"]):
                raise ValueError("motion保留端侧原/渲染像素不符")
            if row["split"] == "review":
                index.protected_pixels.update(digests)
            else:
                for digest in digests:
                    index.pixels[digest].add((row["split"], row["label"]))
            index.identities.add(row["group_id"])
            counts[row["split"]] += 1
    return {"kind": "native_cache", "directory": str(directory), "manifest": file_record(directory / "manifest.json"), "renderer": renderer,
            "files": {records.name: file_record(records)}, "row_counts_by_split": dict(counts)}


def collect_reservation(datasets: list[Path], native_caches: list[Path], renderer: Path) -> dict:
    """核验全部来源及原/产品像素，建立分组/几何索引；未知包、SHA或渲染器违约抛ValueError。"""
    roots, caches = [p.resolve() for p in datasets], [p.resolve() for p in native_caches]
    if not roots or len(set(roots)) != len(roots) or len(set(caches)) != len(caches):
        raise ValueError("motion保留来源重复")
    fingerprint, index = file_record(renderer), _Index()
    snapshots = [_collect_dataset(directory, index) for directory in roots]
    # 旧缓存只提供待保护的既有像素；记录其历史指纹，不声称与本轮渲染器等价。
    snapshots.extend(_collect_cache(directory, index) for directory in caches)
    return {"renderer": {"path": str(renderer.resolve()), "binary": fingerprint}, "source_snapshots": snapshots,
            "pixels": {k: [list(pair) for pair in sorted(v)] for k, v in sorted(index.pixels.items())},
            "geometries": {k: [list(pair) for pair in sorted(v)] for k, v in sorted(index.geometries.items())}, "parent_identities": sorted(index.identities),
            "protected_pixels": sorted(index.protected_pixels), "protected_geometry": sorted(index.protected_geometry),
            "policy": "旧来源原/产品图全部保留；review与独立诊断只作保护，不读取预测或调整新生成参数。"}


def validate_reservation(reservation: dict) -> None:
    """从固定来源重新构建索引，任何来源、原图、像素或保护规则漂移抛ValueError。"""
    datasets = [Path(s["directory"]) for s in reservation["source_snapshots"] if s["kind"] == "dataset"]
    caches = [Path(s["directory"]) for s in reservation["source_snapshots"] if s["kind"] == "native_cache"]
    if collect_reservation(datasets, caches, Path(reservation["renderer"]["path"])) != reservation:
        raise ValueError("motion全局来源/像素保留索引不符")


def quarantine_reasons(rows: list, reservation: dict) -> dict:
    """隔离新包跨划分/异标签像素或旧几何重复；clean冲突连带全部配对，旧包不作修改。"""
    pixels, geometries = defaultdict(set), defaultdict(set)
    for row in rows:
        pair = (row["assigned_split"], row["source_label"])
        pixels[row["pixel_sha256"]].add(pair)
        geometries[row["provenance"]["geometry_sha256"]].add(pair)
    protected_pixels = set(reservation["protected_pixels"])
    protected_geometry = set(reservation["protected_geometry"])
    identities = set(reservation["parent_identities"])
    local = {}
    for row in rows:
        pair = (row["assigned_split"], row["source_label"])
        geometry, digest = row["provenance"]["geometry_sha256"], row["pixel_sha256"]
        if row["parent_id"] in identities or row["group_id"] in identities:
            local[row["sample_id"]] = {"kind": "prior_parent_identity"}
        elif geometry in reservation["geometries"] or geometry in protected_geometry:
            local[row["sample_id"]] = {"kind": "prior_geometry_duplicate", "geometry_sha256": geometry}
        elif digest in protected_pixels:
            local[row["sample_id"]] = {"kind": "protected_pixel", "pixel_sha256": digest}
        elif (any(tuple(p) != pair for p in reservation["pixels"].get(digest, []))
              or len(pixels[digest]) > 1 or len(geometries[geometry]) > 1):
            local[row["sample_id"]] = {"kind": "cross_split_or_label_pixel", "pixel_sha256": digest}
    clean_conflicts = {row["parent_id"]: local[row["sample_id"]] for row in rows
                       if row["provenance"]["variant"]["kind"] == "clean" and row["sample_id"] in local}
    for row in rows:
        if row["parent_id"] in clean_conflicts:
            local[row["sample_id"]] = {"kind": "clean_pair_conflict", "cause": clean_conflicts[row["parent_id"]]}
    return local
