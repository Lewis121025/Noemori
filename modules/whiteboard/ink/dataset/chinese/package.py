"""发布可追溯、按真实来源作者隔离的现代中文负例；只有明确复杂字类进入监督。"""

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

import py7zr
from PIL import Image, ImageDraw

from ..classification.acquire import file_record, publication, write_json
from ..classification.schema import LABELS
from .raster import normalize_image
from .schema import (CHARACTERS, ELIGIBLE_CHARACTERS, EXPECTED_IMAGES, EXPECTED_WRITERS, SOURCE_HASHES,
                     VERSION, parse_member, source_identity, writer_split)

SPLITS = ("train", "val", "test", "review")


def _read(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def _write(path, rows):
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def _verify_sources(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("source") != "newcastle-handwritten-chinese-numbers-v1" or manifest.get("license") != "CC-BY-4.0":
        raise ValueError("中文原始数据许可或来源清单不符")
    for name, digest in SOURCE_HASHES.items():
        if file_record(directory / name)["sha256"] != digest:
            raise ValueError("中文官方归档或许可证据SHA不符")
    metadata = json.loads((directory / "source-metadata.json").read_text())
    if metadata.get("id") != 10280831 or metadata.get("license", {}).get("name") != "CC BY 4.0":
        raise ValueError("中文官方数据条目许可不符，不能借用代码或二次上传许可")
    return manifest


def _make_row(member, data, staging):
    writer, page, code = parse_member(member)
    digest = hashlib.sha256(data).hexdigest()
    identifier = source_identity(member, digest)
    image, normalization = normalize_image(data)
    character = CHARACTERS[code-1]
    accepted = character in ELIGIBLE_CHARACTERS and normalization["usable"]
    image_name, original_name = f"images/{identifier}.png", f"originals/{identifier}.jpg"
    image.save(staging / image_name)
    (staging / original_name).write_bytes(data)
    assigned = writer_split(writer)
    return {"sample_id": identifier, "group_id": f"newcastle-chinese-writer-{writer:03}", "writer_id": f"{writer:03}",
            "split_identity_domain": "newcastle_chinese_numbers", "assigned_split": assigned,
            "split": assigned if accepted else "review", "source_label": character, "label": "other" if accepted else None,
            "annotation_kind": "mapped_source_character", "annotation_status": "accepted" if accepted else "ambiguous_character" if normalization["usable"] else "excluded_image_quality",
            "review_reason": None if accepted else "低笔画/近原语或框形字类整体隔离，不自动作other。" if normalization["usable"] else "空白或极弱/退化原图隔离。",
            "paths": None, "image": image_name, "image_sha256": file_record(staging / image_name)["sha256"],
            "pixel_sha256": hashlib.sha256(image.tobytes()).hexdigest(), "normalization": normalization,
            "provenance": {"source": "newcastle_chinese_numbers", "source_id": f"NewcastleChinese/{member}",
                           "source_member": member, "original_file": original_name, "original_sha256": digest,
                           "archive_sha256": SOURCE_HASHES["Raw Dataset.7z"], "suite_id": writer, "page_id": page, "character_code": code,
                           "source_character": character, "license": "CC-BY-4.0", "doi": "10.17634/137930-3",
                           "derivation_kind": "normalized_scanned_character_raster", "is_human_geometry_gold": False,
                           "writer_evidence": "官方Database.m中studentN_M.jpg→Locate{N,M,code}.jpg；原归档100个suite，README报告100名参与者。"}}


def _isolate_duplicates(rows):
    evidence = []
    for kind, getter in (("original_jpeg", lambda r: r["provenance"]["original_sha256"]), ("normalized_rgb", lambda r: r["pixel_sha256"])):
        groups = defaultdict(list)
        for row in rows:
            groups[getter(row)].append(row)
        for digest, duplicates in groups.items():
            if len(duplicates) < 2:
                continue
            cross_split = len({r["assigned_split"] for r in duplicates}) > 1
            ambiguous = any(r["source_label"] not in ELIGIBLE_CHARACTERS for r in duplicates)
            excluded = duplicates if cross_split or ambiguous else sorted(duplicates, key=lambda r: r["sample_id"])[1:]
            for row in excluded:
                row.update({"label": None, "split": "review", "annotation_status": "excluded_duplicate",
                            "review_reason": "来源JPEG或归一化RGB重复；跨划分/歧义冲突全隔离，其余只留稳定首项。"})
            evidence.append({"kind": kind, "sha256": digest, "sample_ids": [r["sample_id"] for r in duplicates],
                             "excluded_ids": [r["sample_id"] for r in excluded], "cross_assigned_split": cross_split})
    return evidence


def _counts(rows):
    return {"source_images": len(rows), "normalized_views": len(rows), "source_writer_ids": len({r["writer_id"] for r in rows}),
            "source_page_ids": len({(r["writer_id"], r["provenance"]["page_id"]) for r in rows}),
            "splits": {s: sum(r["split"] == s for r in rows) for s in SPLITS},
            "by_split_character": {s: dict(Counter(r["source_label"] for r in rows if r["split"] == s)) for s in SPLITS},
            "statuses": dict(Counter(r["annotation_status"] for r in rows)),
            "assigned_writers": {s: sorted({r["writer_id"] for r in rows if r["assigned_split"] == s}) for s in SPLITS[:3]}}


def generate_dataset(sources: Path, destination: Path) -> dict:
    """从固定CCBY4官方归档原子发布；同作者全部字符保持同split，解包或来源错误整体回滚。"""
    source_manifest = _verify_sources(sources)
    with py7zr.SevenZipFile(sources / "Raw Dataset.7z") as archive:
        members = [info.filename for info in archive.list() if not info.is_directory]
        identities = [parse_member(name) for name in members]
        if len(members) != EXPECTED_IMAGES or len(set(identities)) != len(members) or len({i[0] for i in identities}) != EXPECTED_WRITERS:
            raise ValueError("中文原图/作者数或成员身份重复不符")
        with tempfile.TemporaryDirectory(prefix="newcastle-source-") as temporary, publication(destination) as staging:
            archive.extractall(path=temporary)
            (staging / "images").mkdir()
            (staging / "originals").mkdir()
            rows = [_make_row(member, (Path(temporary) / member).read_bytes(), staging) for member in sorted(members)]
            duplicate_evidence = _isolate_duplicates(rows)
            for split in SPLITS:
                _write(staging / f"{split}.jsonl", [r for r in rows if r["split"] == split])
            _write(staging / "source-index.jsonl", [{"sample_id": r["sample_id"], **r["provenance"]} for r in rows])
            write_json(staging / "duplicate-quarantine.json", duplicate_evidence)
            for source, target in (("source-metadata.json", "source-metadata.json"), ("READ ME.txt", "UPSTREAM.txt"), ("manifest.json", "source-manifest.json")):
                shutil.copyfile(sources / source, staging / target)
            accepted = [r for r in rows if r["annotation_status"] == "accepted"]
            sheet = Image.new("RGB", (224*6, 248*6), "#eeeeee")
            draw = ImageDraw.Draw(sheet)
            for offset, row in enumerate(accepted[::max(1, len(accepted)//36)][:36]):
                x, y = offset % 6*224, offset//6*248
                with Image.open(staging / row["image"]) as image:
                    sheet.paste(image, (x, y))
                draw.text((x+4, y+227), f"suite {row['writer_id']} / code {row['provenance']['character_code']}", fill="black")
            sheet.save(staging / "accepted-contact.png")
            manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS),
                        "split_identity_domain": "newcastle_chinese_numbers", "counts": _counts(rows),
                        "source_evidence": source_manifest, "source_manifest_sha256": file_record(sources / "manifest.json")["sha256"],
                        "dependencies": {"py7zr": py7zr.__version__}, "eligible_characters": sorted(ELIGIBLE_CHARACTERS),
                        "annotation_policy": "固定采集字符类别保守映射other，mapped_source_character；不是逐图人工几何gold。",
                        "split_policy": "官方student/suite为作者，按SHA256(newcastle-writer-split-v1,writer)排序固定80/10/10，全部页面/字符同组。",
                        "attribution": "K Nazarpour and M Chen, Handwritten Chinese Numbers, Newcastle University, doi:10.17634/137930-3, CC BY 4.0",
                        "limitations": ["仅零五六百万亿六个复杂字类作负例，不能代表通用现代中文分布。",
                                        "一二三四七八九十千整体隔离，包括低笔画、框形与近原语歧义；未知个例不强行标注。",
                                        "源Raw Dataset已是64px裁剪处理栅格，不是原扫描纸页或白板实采轨迹。",
                                        "官方README报告100名参与者，归档100个suite；附带示例MATLAB代码N_stu=50，保留版本差异。",
                                        "JPEG文件和224RGB视图为同一来源图，不按视图增加真实原图或作者数量。"],
                        "files": {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}}
            write_json(staging / "manifest.json", manifest)
            validate_dataset(staging)
    return manifest


def validate_dataset(directory: Path) -> dict:
    """核验原JPEG、归一化像素、字符映射、真实作者划分和重复隔离；篡改或丢失来源时报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS)
            or manifest.get("split_identity_domain") != "newcastle_chinese_numbers"
            or manifest.get("eligible_characters") != sorted(ELIGIBLE_CHARACTERS)):
        raise ValueError("中文数据版本、身份域或保守字类映射不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError("中文文件快照SHA不符")
    if (file_record(directory / "source-metadata.json")["sha256"] != SOURCE_HASHES["source-metadata.json"]
            or file_record(directory / "UPSTREAM.txt")["sha256"] != SOURCE_HASHES["READ ME.txt"]
            or file_record(directory / "source-manifest.json")["sha256"] != manifest["source_manifest_sha256"]):
        raise ValueError("中文官方许可与采集证据不符")
    indexed = {r["sample_id"]: r for r in _read(directory / "source-index.jsonl")}
    rows, seen, source_members, seen_pixels, seen_originals = [], set(), set(), set(), set()
    for split in SPLITS:
        for row in _read(directory / f"{split}.jsonl"):
            provenance = row["provenance"]
            member, digest = provenance["source_member"], provenance["original_sha256"]
            writer, page, code = parse_member(member)
            identifier = source_identity(member, digest)
            if (row["sample_id"] != identifier or identifier in seen or member in source_members or row["split"] != split
                    or row["assigned_split"] != writer_split(writer) or row["writer_id"] != f"{writer:03}"
                    or row["group_id"] != f"newcastle-chinese-writer-{writer:03}" or row["split_identity_domain"] != "newcastle_chinese_numbers"):
                raise ValueError("中文原图身份或作者划分不符")
            seen.add(identifier)
            source_members.add(member)
            if (indexed[identifier] != {"sample_id": identifier, **provenance} or provenance["license"] != "CC-BY-4.0"
                    or provenance["archive_sha256"] != SOURCE_HASHES["Raw Dataset.7z"]
                    or (provenance["suite_id"], provenance["page_id"], provenance["character_code"]) != (writer, page, code)
                    or row["source_label"] != CHARACTERS[code-1] or provenance["source_character"] != row["source_label"]
                    or row["annotation_kind"] != "mapped_source_character" or row["paths"] is not None):
                raise ValueError("中文采集标签、来源或原始栅格契约不符")
            if provenance["original_file"] != f"originals/{identifier}.jpg" or row["image"] != f"images/{identifier}.png":
                raise ValueError("中文来源图像路径不符")
            raw = (directory / provenance["original_file"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("中文原JPEG散列不符")
            expected, normalization = normalize_image(raw)
            pixel_digest = hashlib.sha256(expected.tobytes()).hexdigest()
            if normalization != row["normalization"] or pixel_digest != row["pixel_sha256"]:
                raise ValueError("中文归一化与原始JPEG不一致")
            if file_record(directory / row["image"])["sha256"] != row["image_sha256"]:
                raise ValueError("中文归一化PNG散列不符")
            with Image.open(directory / row["image"]) as image:
                if image.mode != "RGB" or image.size != (224, 224) or hashlib.sha256(image.tobytes()).hexdigest() != pixel_digest:
                    raise ValueError("中文图像尺寸、通道或像素不符")
            if split == "review":
                if row["label"] is not None or row["annotation_status"] == "accepted":
                    raise ValueError("中文隔离项不能有监督标签")
            elif (row["label"] != "other" or row["source_label"] not in ELIGIBLE_CHARACTERS or not normalization["usable"]
                  or row["annotation_status"] != "accepted" or split != row["assigned_split"]):
                raise ValueError("中文监督标签或保守类别隔离不符")
            elif pixel_digest in seen_pixels or digest in seen_originals:
                raise ValueError("中文监督存在重复原图或RGB视图")
            else:
                seen_pixels.add(pixel_digest)
                seen_originals.add(digest)
            rows.append(row)
    if (set(indexed) != seen or len(rows) != EXPECTED_IMAGES or len({r["writer_id"] for r in rows}) != EXPECTED_WRITERS
            or _counts(rows) != manifest["counts"] or len(list((directory / "images").iterdir())) != len(rows)
            or len(list((directory / "originals").iterdir())) != len(rows)):
        raise ValueError("中文原图/作者/预处理视图计数不符")
    return manifest["counts"]
