"""发布HDS全部真实来源栅格记录，保留人工顶点及未知派生关系，按作者用户协议隔离。"""

from collections import Counter, defaultdict
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS, content_hash
from .raster import normalize_image
from .schema import (
    ARCHIVE_SHA256, ELLIPSE_MAX_RATIO, EXPECTED_COUNTS, README_SHA256, REVISION, SOURCE_LABELS,
    TEST_WRITERS, VAL_WRITERS, VERSION, hds_split, parse_vertices, resolve_label, validate_record,
)

SPLITS = ("train", "val", "test", "review")
FILE_PATTERN = re.compile(r"data/user\.([a-z0-9]+)/(images|vertices)/(ellipse|rectangle|triangle|other)/([a-z]+)\.([a-z0-9]+)\.(\d+)\.(png|csv)")


def load_archive(path: Path) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """验证固定来源归档并顺序读取图像/顶点与许可证据；拒绝穿越、链接、超限及命名不一致。"""
    if file_record(path)["sha256"] != ARCHIVE_SHA256:
        raise ValueError("HDS固定归档SHA-256不符")
    prefix = f"hand-drawn-shapes-dataset-{REVISION}/"
    data, evidence, seen = {}, {}, set()
    total = 0
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = member.name
            if (PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts or "\\" in name
                    or member.issym() or member.islnk()):
                raise ValueError("HDS归档路径或链接不安全")
            if not member.isfile():
                continue
            if not name.startswith(prefix):
                raise ValueError("HDS归档根目录不符")
            relative = name[len(prefix):]
            match = FILE_PATTERN.fullmatch(relative)
            if match is None and relative not in ("README.md", "Datasheet_for_Datasets.HDS.pdf"):
                if relative.startswith("data/") and relative.endswith((".png", ".csv")):
                    raise ValueError(f"未知来源文件结构：{relative}")
                continue
            if relative in seen or member.size > 1_000_000:
                raise ValueError("重复或过大的HDS素材")
            seen.add(relative)
            total += member.size
            if total > 250_000_000:
                raise ValueError("HDS解压后素材超过预算")
            if match:
                writer, kind, source_label, name_label, name_writer, _, extension = match.groups()
                if (writer != name_writer or source_label != name_label
                        or (kind, extension) not in (("images", "png"), ("vertices", "csv"))):
                    raise ValueError("HDS路径与文件身份不符")
            handle = archive.extractfile(member)
            if handle is None:
                raise ValueError("HDS文件不可读取")
            value = handle.read()
            if len(value) != member.size:
                raise ValueError("HDS归档成员被截断")
            (data if match else evidence)[relative] = value
    if hashlib.sha256(evidence.get("README.md", b"")).hexdigest() != README_SHA256:
        raise ValueError("HDS数据许可README版本不符")
    counts = Counter(path.split("/")[3] for path in data if "/images/" in path)
    if dict(counts) != EXPECTED_COUNTS:
        raise ValueError("HDS来源类别数量与固定版本不符")
    return data, evidence


def _make_record(path, raw, vertices_raw, staging):
    match = FILE_PATTERN.fullmatch(path)
    writer, _, source_label, _, _, _, _ = match.groups()
    raw_hash = hashlib.sha256(raw).hexdigest()
    vertices_hash = hashlib.sha256(vertices_raw).hexdigest() if vertices_raw is not None else None
    vertices, vertex_error = None, None
    if vertices_raw is not None:
        try:
            vertices = parse_vertices(vertices_raw, source_label)
        except ValueError as error:
            vertex_error = str(error)
    resolution = resolve_label(source_label, vertices)
    if vertex_error:
        resolution = {"label": None, "status": "ambiguous", "reason": f"原始人工CSV需要复核：{vertex_error}"}
    image, normalization = normalize_image(raw)
    if normalization["empty"]:
        resolution = {"label": None, "status": "excluded_empty", "reason": "来源图像没有可见墨迹。"}
    identifier = content_hash([REVISION, path, raw_hash, vertices_hash])[:32]
    image_path = f"images/{identifier}.png"
    image.save(staging / image_path)
    assigned = hds_split(writer)
    label = resolution["label"]
    return {"sample_id": identifier, "group_id": f"hds-writer-{writer}", "writer_id": writer,
            "assigned_split": assigned, "split": assigned if label is not None else "review",
            "source_label": source_label, "label": label, "annotation_kind": "human_annotation",
            "annotation_status": resolution["status"], "review_reason": None if label is not None else resolution["reason"],
            "vertices": vertices, "geometry_annotation": resolution,
            "image": image_path, "image_sha256": file_record(staging / image_path)["sha256"],
            "pixel_sha256": hashlib.sha256(image.tobytes()).hexdigest(), "normalization": normalization,
            "provenance": {"source": "HDS", "revision": REVISION, "source_id": f"HDS/{path}",
                           "original_file": path, "original_sha256": raw_hash,
                           "vertices_file": path.replace("/images/", "/vertices/").replace(".png", ".csv") if vertices_raw is not None else None,
                           "vertices_sha256": vertices_hash, "source_label": source_label, "source_writer_id": writer,
                           "license": "CC-BY-4.0", "license_evidence": "SOURCE_README.txt, Licenses",
                           "parent_source_id": None,
                           "derivation_kind": "normalized_real_no_stretch_reported" if source_label == "other" else "source_mixture_original_or_stretched_unresolved",
                           "label_evidence": "作者Datasheet第5/7页：现场采集，作者人工查看、清理、标类别和顶点。"}}


def _quarantine_duplicates(records):
    pixels = defaultdict(list)
    for record in records:
        pixels[record["pixel_sha256"]].append(record)
    groups = []
    for digest, duplicates in pixels.items():
        if len({r["assigned_split"] for r in duplicates}) <= 1:
            continue
        groups.append({"pixel_sha256": digest, "sample_ids": [r["sample_id"] for r in duplicates],
                       "writers": sorted({r["writer_id"] for r in duplicates}),
                       "assigned_splits": sorted({r["assigned_split"] for r in duplicates})})
        for record in duplicates:
            record.update({"split": "review", "label": None, "annotation_status": "excluded_cross_split_duplicate",
                           "review_reason": "同一RGB像素出现在不同作者划分，全部副本隔离，不移动用户。"})
    return groups


def _counts(records):
    return {"records": len(records), "by_source_label": dict(Counter(r["source_label"] for r in records)),
            "splits": {s: sum(r["split"] == s for r in records) for s in SPLITS},
            "by_split_label": {s: {label: sum(r["split"] == s and r["label"] == label for r in records) for label in LABELS}
                               for s in SPLITS},
            "by_annotation_status": dict(Counter(r["annotation_status"] for r in records)),
            "source_writer_ids": len({r["writer_id"] for r in records}),
            "assigned_writers": {s: sorted({r["writer_id"] for r in records if r["assigned_split"] == s}) for s in SPLITS[:3]},
            "derivation_kinds": dict(Counter(r["provenance"]["derivation_kind"] for r in records)),
            "independent_original_drawing_count": None,
            "unknown_original_or_stretched_records": sum(r["source_label"] != "other" for r in records)}


def _sheet(path, records, staging, caption):
    if not records:
        return
    sheet = Image.new("RGB", (224 * 5, 248 * ((len(records) + 4) // 5)), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for index, record in enumerate(records):
        x, y = index % 5 * 224, index // 5 * 248
        with Image.open(staging / record["image"]) as image:
            sheet.paste(image, (x, y))
        draw.text((x + 5, y + 227), caption(index, record), fill="black")
    sheet.save(path)


def _review_sheets(staging, records):
    ellipse = [r for r in records if r["source_label"] == "ellipse"]
    bins = ((0, .4), (.4, .6), (.6, .75), (.75, .85), (.85, .9), (.9, .95), (.95, 1.000001))
    bin_counts, filenames, index = {}, [], []
    for low, high in bins:
        key = f"{low:.2f}-{high:.2f}"
        selected = [r for r in ellipse if low <= r["geometry_annotation"].get("axis_ratio", -1) < high]
        selected.sort(key=lambda r: r["sample_id"])
        bin_counts[key] = len(selected)
        name = f"ellipse-axis-{key}.png"
        if selected:
            _sheet(staging / name, selected[:20], staging,
                   lambda i, r: f"{i+1:02} / ratio {r['geometry_annotation']['axis_ratio']:.3f}")
            filenames.append(name)
            index.extend({"sheet": name, "index": i + 1, "sample_id": r["sample_id"]} for i, r in enumerate(selected[:20]))
    near = sorted((r for r in ellipse if r["split"] == "review" and r["geometry_annotation"].get("axis_ratio", 0) > .85),
                  key=lambda r: content_hash(["hds-blind-near-circle", r["sample_id"]]))[:120]
    for page in range((len(near) + 19) // 20):
        name = f"blind-near-circle-{page+1:02}.png"
        _sheet(staging / name, near[page*20:(page+1)*20], staging, lambda i, r: f"{page*20+i+1:03}")
        filenames.append(name)
    with (staging / "near-circle-review-selection.jsonl").open("w") as handle:
        for i, record in enumerate(near, 1):
            handle.write(json.dumps({"blind_index": i, "sample_id": record["sample_id"],
                                     "original_sha256": record["provenance"]["original_sha256"],
                                     "assigned_split": record["assigned_split"], "image": record["image"]}) + "\n")
    write_json(staging / "ellipse-axis-sheet-index.json", index)
    return {"bins": bin_counts, "blind_near_circle_cases": len(near),
            "blind_selection": "轴比>0.85的review，按hash(hds-blind-near-circle,sample_id)取前120；不读取预测。"}, filenames


def validate_dataset(directory: Path) -> dict:
    """核验全部HDS来源、用户隔离、标签映射与RGB图像；记录/图片损坏及跨用户泄漏抛 ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS):
        raise ValueError("HDS数据版本或类别不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("HDS文件散列或路径不符")
    records, identifiers, source_ids, writer_splits, pixel_splits = [], set(), set(), {}, {}
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                record = json.loads(line)
                validate_record(record)
                if record["split"] != split or record["sample_id"] in identifiers:
                    raise ValueError("HDS记录重复或文件划分不符")
                identifiers.add(record["sample_id"])
                source = record["provenance"]
                if source["source_id"] in source_ids:
                    raise ValueError("原始HDS图像重复导入")
                source_ids.add(source["source_id"])
                identity = content_hash([REVISION, source["original_file"], source["original_sha256"], source["vertices_sha256"]])[:32]
                if identity != record["sample_id"]:
                    raise ValueError("HDS原始内容身份不符")
                if writer_splits.setdefault(record["writer_id"], record["assigned_split"]) != record["assigned_split"]:
                    raise ValueError("同来源用户跨作者划分")
                if split != "review":
                    resolution = resolve_label(record["source_label"], record["vertices"])
                    if resolution["label"] != record["label"] or resolution != record["geometry_annotation"]:
                        raise ValueError("训练标签不符合人工类别/顶点规则")
                    if pixel_splits.setdefault(record["pixel_sha256"], split) != split:
                        raise ValueError("相同RGB像素跨训练验证测试")
                image_path = directory / record["image"]
                if file_record(image_path)["sha256"] != record["image_sha256"]:
                    raise ValueError("HDS图像SHA不符")
                with Image.open(image_path) as image:
                    if image.mode != "RGB" or image.size != (224, 224) or hashlib.sha256(image.tobytes()).hexdigest() != record["pixel_sha256"]:
                        raise ValueError("HDS图像尺寸/模式或像素SHA不符")
                records.append(record)
    counts = _counts(records)
    if counts != manifest["counts"] or len(list((directory / "images").iterdir())) != len(records):
        raise ValueError("HDS统计或图像数量不符")
    return counts


def generate_dataset(source_archive: Path, destination: Path) -> dict:
    """从固定真实来源归档原子发布全部记录；不伪造母图关系，不覆盖现有数据，失败自动清理。"""
    if PILLOW_VERSION != "12.1.0":
        raise ValueError("要求固定栅格依赖 pillow==12.1.0")
    data, evidence = load_archive(source_archive)
    with publication(destination) as staging:
        (staging / "images").mkdir()
        records = []
        images = sorted(path for path in data if "/images/" in path)
        for path in images:
            vertex_path = path.replace("/images/", "/vertices/").replace(".png", ".csv")
            source_label = path.split("/")[3]
            vertices_raw = data.get(vertex_path)
            if source_label != "other" and vertices_raw is None:
                raise ValueError("HDS正例缺少原始人工顶点文件")
            records.append(_make_record(path, data[path], vertices_raw, staging))
        duplicates = _quarantine_duplicates(records)
        with ExitStack() as stack:
            handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("w")) for split in SPLITS}
            for record in records:
                validate_record(record)
                handles[record["split"]].write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        write_json(staging / "duplicate-quarantine.json", duplicates)
        (staging / "SOURCE_README.txt").write_bytes(evidence["README.md"])
        (staging / "SOURCE_DATASHEET.pdf").write_bytes(evidence["Datasheet_for_Datasets.HDS.pdf"])
        review_summary, sheets = _review_sheets(staging, records)
        files = [*(f"{split}.jsonl" for split in SPLITS), "duplicate-quarantine.json", "SOURCE_README.txt",
                 "SOURCE_DATASHEET.pdf", "near-circle-review-selection.jsonl", "ellipse-axis-sheet-index.json", *sheets]
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS), "input_kind": "source_raster",
                    "source_evidence": {"repository": "https://github.com/frobertpixto/hand-drawn-shapes-dataset",
                                        "revision": REVISION, "archive": file_record(source_archive),
                                        "license": "CC-BY-4.0", "attribution": "Hand-drawn Shapes (HDS) Dataset ©2022 Francois Robert",
                                        "license_evidence": "SOURCE_README.txt Licenses / SOURCE_DATASHEET.pdf page8",
                                        "annotation_evidence": "Datasheet pages5/7: author collected in person, manually labelled and reviewed.",
                                        "source_labels": list(SOURCE_LABELS)},
                    "split_policy": {"unit": "source_writer_id", "author_protocol": "Datasheet page3 classification split",
                                     "test_writers": list(TEST_WRITERS), "val_writers": list(VAL_WRITERS),
                                     "train_writers": "其余来源用户ID", "all_variants_of_writer_together": True,
                                     "review_policy": "review隔离不参加训练；assigned_split保留作者原分配，未来审核不能跨划分。"},
                    "label_policy": {"rectangle_triangle": "作者人工类别及非退化人工顶点",
                                     "ellipse": f"作者ellipse类别，人工顶点双轴可信且短长轴比≤{ELLIPSE_MAX_RATIO}",
                                     "circle": "不从ellipse提示类别自动派生circle；近圆保留review",
                                     "other": "与七类修复范围不等价，所有原other暂保留review"},
                    "counts": _counts(records), "review_sheets": review_summary,
                    "cross_split_duplicate_groups": len(duplicates),
                    "preprocessing": {"source_size": [70, 70], "target_size": [224, 224], "mode": "RGB",
                                      "padding": 16, "polarity": "black_on_white", "preserve_aspect_ratio": True,
                                      "pillow": PILLOW_VERSION, "vertices_space": "原始70px图的归一化坐标，未伪装成轨迹"},
                    "limitations": ["20005条几何图含原图及横向拉伸变体；上游未给逐条对应，独立原始手绘数量未知。",
                                    "37是来源用户ID数量，无法额外核实为37个自然人；按作者推荐用户隔离。",
                                    "仅有70px栅格；224px只是等比预处理，不增加原始细节或恢复真实矢量。",
                                    "circle/arc真实正例仍未由本包提供，近圆边界仍需独立复核。",
                                    "author other不等于Noemori other，7287条保留真实原标签但不自动训练。",
                                    "本包没有AI视觉复核标签；人工来源和规则映射不得记为新的人工七类标注。"],
                    "files": {name: file_record(staging / name) for name in files},
                    "generator_sources": {path.name: file_record(path)["sha256"] for path in sorted(Path(__file__).parent.glob("*.py"))}}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest
