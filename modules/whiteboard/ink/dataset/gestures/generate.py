"""从固定 MMG 归档生成独立数据包；在发布前校验图像、标签和真实书写者隔离。"""

from collections import Counter
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import stat
import zipfile

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION

from ..classification.acquire import file_record, publication, write_json
from ..classification.render import render_image
from ..classification.schema import LABELS, content_hash
from .schema import (
    EXCLUDED_LABELS, LABEL_MAP, LICENSE_ID, LICENSE_QUOTE, MMG_SHA256, README_SHA256,
    VERSION, WRITER_DEVICES, XML_SHA256, classification_sample, parse_mmg_xml,
    safe_member, validate_sample, writer_assignments,
)

SPLITS = ("train", "val", "test")
FILES = ("train.jsonl", "val.jsonl", "test.jsonl", "source-index.jsonl", "excluded.json", "README.mmg.txt", "preview.png")
EXPECTED_XML_COUNT = 9598
LIMITATIONS = [
    "类别来自受控手势采集任务，不等于逐个样本由独立人工确认的几何真值。",
    "arrowhead 已抽查每位用户每种速度的第一条，共60幅，均有箭杆和双翼；仍不是600幅逐例人工复核。",
    "本包只有真实 arrow、line、other，没有虚构 circle/ellipse/arc/rectangle/triangle。",
    "$1 xml.zip 有圆、矩形和三角形，但数据许可没有明确证据，整体隔离且不进入训练。",
    "I 与部分缺点的感叹号可能和直线视觉重合；D/P/half_note 未完成语义审核，均隔离。",
    "箭头主要朝右，其他类别也有固定模板方向；不能用此分布宣称任意方向或真实白板泛化。",
    "20名用户按设备分层12/4/4，是真实用户隔离；同一采集实验的测试不等同跨产品/设备泛化。",
    "MMG README 声明允许手势识别/交互工作并要求引用；不是BSD/CC标准数据许可，后续产品再分发需另核。",
]


def _archive_records(sources: Path):
    archive_path = sources / "mmg.zip"
    if file_record(archive_path)["sha256"] != MMG_SHA256:
        raise ValueError("MMG 归档与核查版本不符")
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(set(names)) != len(names) or len(names) > 12000 or sum(info.file_size for info in infos) > 60_000_000:
            raise ValueError("归档成员重复或超过大小预算")
        for info in infos:
            safe_member(info.filename)
            if stat.S_ISLNK(info.external_attr >> 16) or info.file_size > 1_000_000:
                raise ValueError("拒绝符号链接或过大成员")
        readme = archive.read("README.txt")
        if hashlib.sha256(readme).hexdigest() != README_SHA256 or LICENSE_QUOTE not in readme.decode("cp1252"):
            raise ValueError("MMG 数据用途声明不符")
        xml_names = sorted(name for name in names if name.endswith(".xml"))
        if len(xml_names) != EXPECTED_XML_COUNT:
            raise ValueError("MMG XML 文件数量不符")
        for name in xml_names:
            yield parse_mmg_xml(archive.read(name), name)


def _counts(rows: list[dict]) -> dict:
    split_counts, label_counts, source_counts = Counter(), Counter(), Counter()
    writers = {split: set() for split in SPLITS}
    for row in rows:
        s = row["sample"]
        split_counts[s["split"]] += 1
        label_counts[(s["split"], s["label"])] += 1
        source_counts[(s["split"], s["provenance"]["source_label"])] += 1
        writers[s["split"]].add(s["provenance"]["writer_id"])
    return {"samples": len(rows), "splits": {split: split_counts[split] for split in SPLITS},
            "by_split_label": {split: {label: label_counts[(split, label)] for label in LABELS} for split in SPLITS},
            "by_split_source_label": {split: {label: source_counts[(split, label)] for label in LABEL_MAP} for split in SPLITS},
            "writers": {split: sorted(writers[split], key=int) for split in SPLITS}}


def _write_samples(sources: Path, staging: Path):
    (staging / "images").mkdir()
    rows, excluded, source_index, representatives = [], [], [], {}
    for gesture in _archive_records(sources):
        info = {"source_id": gesture.source_id, "source_sha256": gesture.source_sha256,
                "writer_id": gesture.writer_id, "source_label": gesture.source_label,
                "speed": gesture.speed, "repetition": gesture.repetition,
                "geometry_sha256": content_hash(gesture.paths),
                "included": gesture.source_label in LABEL_MAP}
        source_index.append(info)
        if gesture.source_label not in LABEL_MAP:
            excluded.append({**info, "reason": EXCLUDED_LABELS[gesture.source_label]})
            continue
        sample = classification_sample(gesture)
        validate_sample(sample)
        image_name = f"images/{sample['sample_id']}.png"
        render_image(sample["paths"]).save(staging / image_name)
        rows.append({"sample": sample, "image": image_name, "image_sha256": file_record(staging / image_name)["sha256"]})
    rows = _exclude_duplicates(staging, rows, source_index, excluded)
    with ExitStack() as stack:
        handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("w")) for split in SPLITS}
        for row in rows:
            sample = row["sample"]
            handles[sample["split"]].write(json.dumps(row, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n")
            key = (sample["provenance"]["source_label"], sample["split"])
            if key not in representatives:
                with Image.open(staging / row["image"]) as image:
                    representatives[key] = (image.copy(), sample["provenance"]["writer_id"])
    with (staging / "source-index.jsonl").open("w") as output:
        for info in source_index:
            output.write(json.dumps(info, separators=(",", ":")) + "\n")
    write_json(staging / "excluded.json", excluded)
    sheet = Image.new("RGB", (224 * 3, 248 * len(LABEL_MAP)), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for row_index, label in enumerate(LABEL_MAP):
        for column, split in enumerate(SPLITS):
            representative = representatives.get((label, split))
            if representative is None:
                continue
            image, writer = representative
            x, y = column * 224, row_index * 248
            sheet.paste(image, (x, y))
            draw.text((x + 6, y + 227), f"{label} / {split} / writer {writer}", fill="black")
    sheet.save(staging / "preview.png")
    return rows, source_index, excluded


def _exclude_duplicates(staging, rows, source_index, excluded):
    image_splits = {}
    for row in rows:
        image_splits.setdefault(row["image_sha256"], set()).add(row["sample"]["split"])
    conflicts = {digest for digest, splits in image_splits.items() if len(splits) > 1}
    index = {record["source_id"]: record for record in source_index}
    kept = []
    for row in rows:
        if row["image_sha256"] not in conflicts:
            kept.append(row)
            continue
        info = index[row["sample"]["provenance"]["source_id"]]
        info["included"] = False
        excluded.append({**info, "reason": "归一化后与其他划分图片逐字节相同；全部副本隔离，用户划分不变。",
                         "image_sha256": row["image_sha256"], "exclusion_kind": "cross_split_duplicate"})
        (staging / row["image"]).unlink()
    return kept


def _source_manifest(sources: Path, index: list[dict]) -> dict:
    counts = Counter(item["source_label"] for item in index)
    missing = []
    present = {(r["writer_id"], r["source_label"], r["speed"], r["repetition"]) for r in index}
    for writer in sorted(WRITER_DEVICES, key=int):
        for label in sorted(LABEL_MAP.keys() | EXCLUDED_LABELS.keys()):
            for speed in ("SLOW", "MEDIUM", "FAST"):
                for repetition in range(1, 11):
                    if (writer, label, speed, repetition) not in present:
                        missing.append({"writer_id": writer, "source_label": label, "speed": speed, "repetition": repetition})
    return {"url": "https://depts.washington.edu/acelab/proj/dollar/mmg.zip", **file_record(sources / "mmg.zip"),
            "actual_xml_count": len(index), "readme_claimed_count": 9600, "missing_records": missing,
            "source_label_counts": dict(sorted(counts.items()))}


def validate_dataset(directory: Path) -> dict:
    """逐文件核验真实数据与固定用户划分、XML索引及图像；重复、污染、损坏或许可不符时报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS)
            or manifest.get("writer_assignments") != writer_assignments()
            or manifest.get("license", {}).get("id") != LICENSE_ID):
        raise ValueError("MMG manifest 版本、类别、用户划分或许可不符")
    if set(manifest["files"]) != set(FILES):
        raise ValueError("数据包文件列表不符")
    for name in FILES:
        if file_record(directory / name) != manifest["files"][name]:
            raise ValueError(f"文件散列不符：{name}")
    if file_record(directory / "README.mmg.txt")["sha256"] != README_SHA256:
        raise ValueError("MMG README 许可原文散列不符")
    with (directory / "source-index.jsonl").open() as handle:
        index_rows = [json.loads(line) for line in handle]
    index = {r["source_id"]: r for r in index_rows}
    if len(index) != len(index_rows) or len(index) != manifest["source"]["actual_xml_count"]:
        raise ValueError("XML 原始索引重复或数量不符")
    rows, ids, writer_splits, image_splits, included = [], set(), {}, {}, set()
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                row = json.loads(line)
                if set(row) != {"sample", "image", "image_sha256"}:
                    raise ValueError("图像索引字段不符")
                s = row["sample"]
                validate_sample(s)
                p = s["provenance"]
                if s["split"] != split or writer_splits.setdefault(p["writer_id"], split) != split:
                    raise ValueError("同一真实书写者跨划分")
                source = index.get(p["source_id"])
                if (source is None or not source["included"] or source["source_sha256"] != p["source_sha256"]
                        or source["geometry_sha256"] != content_hash(s["paths"])):
                    raise ValueError("样本几何与原始 XML 索引不符")
                included.add(p["source_id"])
                if s["sample_id"] in ids or row["image"] != f"images/{s['sample_id']}.png":
                    raise ValueError("样本重复或图像路径不符")
                ids.add(s["sample_id"])
                path = directory / row["image"]
                if file_record(path)["sha256"] != row["image_sha256"]:
                    raise ValueError("图片散列不符")
                if image_splits.setdefault(row["image_sha256"], split) != split:
                    raise ValueError("完全相同图片跨用户划分")
                with Image.open(path) as image:
                    if image.size != (224, 224) or image.mode != "RGB":
                        raise ValueError("图片尺寸或通道不符")
                    image.verify()
                rows.append(row)
    excluded = json.loads((directory / "excluded.json").read_text())
    excluded_ids = {r["source_id"] for r in excluded}
    if (included != {name for name, r in index.items() if r["included"]}
            or excluded_ids != set(index) - included or len(excluded_ids) != len(excluded)):
        raise ValueError("原始记录未完整分配或隔离样本进入训练")
    if len(list((directory / "images").iterdir())) != len(ids):
        raise ValueError("图片数量不符")
    actual = _counts(rows)
    if actual != manifest["counts"]:
        raise ValueError("manifest 数量不符")
    return actual


def generate_dataset(sources: Path, destination: Path) -> dict:
    """从已下载固定归档原子发布 MMG 数据；仅处理有数据用途声明的来源，不覆盖旧目录。"""
    if PILLOW_VERSION != "12.1.0":
        raise ValueError("要求固定栅格化依赖 pillow==12.1.0")
    with publication(destination) as staging:
        rows, index, excluded = _write_samples(sources, staging)
        with zipfile.ZipFile(sources / "mmg.zip") as archive:
            (staging / "README.mmg.txt").write_bytes(archive.read("README.txt"))
        source = _source_manifest(sources, index)
        quarantined = {"source": "$1 unistroke XML logs", "url": "https://depts.washington.edu/acelab/proj/dollar/xml.zip",
                       "sha256": XML_SHA256, "status": "quarantined_license_unconfirmed", "training_samples": 0,
                       "reason": "归档没有数据许可证，网页New BSD明确指软件，不能扩张为数据许可。",
                       "available_but_unused": {"arrow": 330, "circle": 330, "rectangle": 330, "triangle": 330}}
        files = [*sorted(Path(__file__).parent.glob("*.py")), Path(__file__).parent.parent / "classification" / "render.py"]
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS),
                    "render": {"size": [224, 224], "mode": "RGB", "preserve_aspect_ratio": True,
                               "padding": 16, "stroke_width": 3, "pillow": PILLOW_VERSION},
                    "source": source, "writer_assignments": writer_assignments(), "writer_devices": WRITER_DEVICES,
                    "split_policy": {"unit": "real_writer_id", "stratify_by": "input_type",
                                     "method": "设备内按SHA-256('mmg-user-split-v1|' + writer_id)排序，前6训练、接着2验证、最后2测试",
                                     "same_writer_all_speeds_repetitions_together": True,
                                     "writers_per_split": {"train": 12, "val": 4, "test": 4}},
                    "label_map": LABEL_MAP, "excluded_labels": EXCLUDED_LABELS,
                    "counts": _counts(rows), "excluded_records": len(excluded),
                    "cross_split_duplicate_exclusions": sum(r.get("exclusion_kind") == "cross_split_duplicate" for r in excluded),
                    "license": {"id": LICENSE_ID, "kind": "dataset-specific custom use statement", "quote": LICENSE_QUOTE,
                                "evidence": "mmg.zip/README.txt", "evidence_sha256": README_SHA256,
                                "citation": "Anthony, L. and Wobbrock, J.O. 2012. $N-Protractor: A Fast and Accurate Multistroke Recognizer. Graphics Interface 2012, pp.117-120.",
                                "scope": "本次手势识别研究训练；不是BSD，产品数据或衍生物再分发资格需单独核对。"},
                    "quarantined_sources": [quarantined], "limitations": LIMITATIONS,
                    "files": {name: file_record(staging / name) for name in FILES},
                    "generator_sources": {str(path.relative_to(Path(__file__).parent.parent)): file_record(path)["sha256"] for path in files}}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest
