"""从固定许可快照发布大规模真实字符负例；所有派生和隔离决定均可审计。"""

from collections import Counter, defaultdict
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import zipfile

import numpy as np
from PIL import Image, ImageChops, ImageDraw
from scipy.io import loadmat

from ..classification.acquire import file_record, publication, write_json
from ..classification.render import render_image
from ..classification.schema import LABELS, content_hash
from .parsers import integrate_velocity, parse_unipen
from .schema import ARCHIVES, SPLITS, VERSION, eligible_label, expected_identity, stable_hash, validate_record

EVIDENCE = {
    "pendigits-page.html": "217ef1de678bcee66dc3b86194afa21e961eb61e244d0c681130682500f85b9b",
    "trajectories-page.html": "2684e020fa916b94ea63f8f54d4d30a0540f6c4e382d07fd84345bc4e613935b",
    "UPSTREAM.txt": "7a9a51b9606924bd404bfeabb8504d294624350254fe300aa26d810b75fd1cf8",
}
LIMITATIONS = [
    "字符来源有人工字符类别，但本包映射为other不等于每图经过人工几何审核。近原语字符类别被隔离。",
    "Pendigits使用原UNIPEN坐标，保留多笔画；不同官方队列的局部作者编号不能合并。",
    "Character Trajectories只有一位匿名作者，全部训练使用；坐标是还原轴单位后积分平滑速度所得。",
    "Kanji是历史日文汉字的离线栅格，缺少作者和书页身份；测试隔离的是源字类，不能声称作者隔离。",
    "本包没有现代中文、Noemori真实设备采集或全面未知图形拒绝能力的证明。",
    "训练增强和静态渲染不计为新增真实原样本，白板单笔修复表现仍需原轨迹与几何拟合评估。",
]


def normalize_kanji(data: bytes) -> tuple[Image.Image, dict]:
    """反转原64px白墨黑底栅格并等比居中；空白保留复核，不制造原始轨迹。"""
    with Image.open(io.BytesIO(data)) as source:
        if source.format != "PNG" or source.size != (64, 64) or source.mode != "L":
            raise ValueError("Kanji原图必须是64×64灰度PNG")
        source.load()
        gray = ImageChops.invert(source)
    box = ImageChops.invert(gray).point(lambda value: 255 if value >= 5 else 0).getbbox()
    output = Image.new("RGB", (224, 224), "white")
    info = {"source_size": [64, 64], "input_kind": "source_raster", "inverted": True,
            "preserve_aspect_ratio": True, "padding": 16, "empty": box is None,
            "source_ink_bbox": list(box) if box else None, "resampling": "Pillow.LANCZOS"}
    if box:
        crop = gray.crop(box)
        scale = 192 / max(crop.size)
        size = tuple(max(1, round(value * scale)) for value in crop.size)
        offset = tuple((224 - value) // 2 for value in size)
        output.paste(crop.resize(size, Image.Resampling.LANCZOS).convert("RGB"), offset)
        info.update({"rendered_size": list(size), "offset": list(offset)})
    return output, info


def _verify_sources(uci: Path, kanji: Path) -> dict:
    for name, digest in ARCHIVES.items():
        root = kanji if name == "kkanji.tar" else uci
        if file_record(root / name)["sha256"] != digest:
            raise ValueError(f"字符归档不符：{name}")
    for name, digest in EVIDENCE.items():
        root = kanji if name == "UPSTREAM.txt" else uci
        if file_record(root / name)["sha256"] != digest:
            raise ValueError(f"字符数据许可快照不符：{name}")
    return {"uci": json.loads((uci / "manifest.json").read_text()),
            "kanji": json.loads((kanji / "manifest.json").read_text())}


def _digit_rows(uci: Path):
    with zipfile.ZipFile(uci / "pendigits.zip") as archive:
        for cohort, suffix, expected in (("train", "tra", 7494), ("test", "tes", 3498)):
            member = f"pendigits-orig.{suffix}.Z"
            text = subprocess.run(["gzip", "-cd"], input=archive.read(member),
                                  stdout=subprocess.PIPE, check=True).stdout.decode("ascii")
            rows = parse_unipen(text, cohort)
            if len(rows) != expected:
                raise ValueError("Pendigits原始队列数量不符")
            for row in rows:
                p = {"source": "pendigits", "cohort": cohort, "local_writer_id": row["writer"],
                     "original_sample_id": row["original_id"], "source_member": member,
                     "source_id": f"pendigits/{cohort}/writer-{row['writer']}/{row['original_id']}",
                     "source_sha256": row["source_sha256"], "archive_sha256": ARCHIVES["pendigits.zip"],
                     "license": "CC-BY-4.0", "derivation": "original_unipen_screen_y_negated"}
                yield row["label"], row["paths"], p


def _letter_rows(uci: Path):
    with zipfile.ZipFile(uci / "trajectories.zip") as archive:
        data = loadmat(io.BytesIO(archive.read("mixoutALL_shifted.mat")), simplify_cells=True)
    matrices, consts = data["mixout"], data["consts"]
    keys, labels, units = consts["key"], consts["charlabels"], consts["datanorm"]
    if len(matrices) != 2858 or len(labels) != 2858 or list(keys) != list("abcdeghlmnopqrsuvwyz"):
        raise ValueError("Character Trajectories来源类别或数量不符")
    for index, (matrix, label) in enumerate(zip(matrices, labels)):
        if int(label) != label or not 1 <= label <= len(keys):
            raise ValueError("Character Trajectories标签索引非法")
        paths = integrate_velocity(matrix, units)
        p = {"source": "character_trajectories", "source_id": f"character_trajectories/sample-{index:04d}",
             "source_member": "mixoutALL_shifted.mat", "source_sample_index": index,
             "source_sha256": content_hash({"matrix": np.asarray(matrix).tolist(), "datanorm": np.asarray(units).tolist()}),
             "axis_datanorm": np.asarray(units).tolist(), "archive_sha256": ARCHIVES["trajectories.zip"],
             "license": "CC-BY-4.0",
             "derivation": "integrated_axis_denormalized_smoothed_velocity_screen_y_negated"}
        yield str(keys[int(label) - 1]), paths, p


def _kanji_rows(kanji: Path, cap: int, index: list[dict]):
    with tarfile.open(kanji / "kkanji.tar") as archive:
        groups = defaultdict(list)
        for member in archive.getmembers():
            if member.isdir():
                continue
            if (not member.isfile() or not re.fullmatch(r"kkanji2/U\+[0-9A-F]{4,6}/[0-9a-f]+\.png", member.name)
                    or member.size > 100_000):
                raise ValueError("Kanji归档成员不合法")
            groups[member.name.split("/")[1]].append(member)
        if sum(map(len, groups.values())) != 140424 or len(groups) != 3832:
            raise ValueError("Kanji来源数量不符")
        for code, members in sorted(groups.items()):
            label = chr(int(code[2:], 16))
            ordered = sorted(members, key=lambda member: stable_hash(member.name))
            for rank, member in enumerate(ordered):
                selected = rank < cap and eligible_label("kuzushiji_kanji", label)
                info = {"source": "kuzushiji_kanji", "source_id": member.name, "source_label": label,
                        "character_class": code, "selected": selected,
                        "selection_reason": "stable_per_character_cap" if selected else
                            "primitive_like_character_class" if not eligible_label("kuzushiji_kanji", label) else "outside_per_character_cap"}
                index.append(info)
                if not selected:
                    continue
                with archive.extractfile(member) as handle:
                    raw = handle.read()
                image, normalization = normalize_kanji(raw)
                p = {"source": "kuzushiji_kanji", "source_id": member.name, "source_member": member.name,
                     "character_class": code, "source_sha256": hashlib.sha256(raw).hexdigest(),
                     "archive_sha256": ARCHIVES["kkanji.tar"], "license": "CC-BY-SA-4.0",
                     "derivation": "source_raster_inverted_aspect_preserved"}
                yield label, image, normalization, p


def _make_row(label, paths, image, normalization, p, staging):
    sample_id = stable_hash(p["source_id"])[:32]
    group, writer, assigned = expected_identity(p)
    accepted = eligible_label(p["source"], label) and not normalization.get("empty")
    row = {"sample_id": sample_id, "group_id": group, "writer_id": writer, "assigned_split": assigned,
           "split": assigned if accepted else "review", "source_label": label,
           "label": "other" if accepted else None, "annotation_kind": "mapped_source_character",
           "annotation_status": "accepted" if accepted else "quarantined",
           "review_reason": "来源字符类别映射为负例；不是逐图几何人工真值。" if accepted else "字类可能与原语重合或输入为空，隔离。",
           "image": f"images/{sample_id}.png", "image_sha256": "", "pixel_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
           "normalization": normalization, "paths": paths, "provenance": p}
    image.save(staging / row["image"])
    row["image_sha256"] = file_record(staging / row["image"])["sha256"]
    validate_record(row)
    return row


def _counts(rows: list[dict]) -> dict:
    counts = Counter((r["split"], r["provenance"]["source"]) for r in rows)
    return {"records": len(rows), "supervised": sum(r["split"] != "review" for r in rows),
            "by_split_source": {split: {source: counts[split, source] for source in
                                ("pendigits", "character_trajectories", "kuzushiji_kanji")} for split in SPLITS},
            "groups": {split: len({r["group_id"] for r in rows if r["split"] == split}) for split in SPLITS}}


def _isolate_duplicates(rows):
    by_pixel = defaultdict(list)
    for row in rows:
        if row["split"] != "review":
            by_pixel[row["pixel_sha256"]].append(row)
    quarantined = []
    for digest, copies in by_pixel.items():
        # 全部副本隔离，不能把测试作者的样本迁移到训练作者组。
        if len(copies) > 1:
            for row in copies:
                row.update({"split": "review", "label": None, "annotation_status": "quarantined",
                            "review_reason": "规范化后存在完全相同像素，全部副本隔离，不更改来源分组。"})
                quarantined.append({"sample_id": row["sample_id"], "pixel_sha256": digest,
                                    "assigned_split": row["assigned_split"]})
    return quarantined


def _audit_sheet(staging, rows):
    selection = []
    for source in ("pendigits", "character_trajectories", "kuzushiji_kanji"):
        for split in ("train", "val", "test"):
            candidates = [r for r in rows if r["provenance"]["source"] == source and r["split"] == split]
            selection.extend(sorted(candidates, key=lambda r: stable_hash("audit/" + r["sample_id"]))[:24])
    sheet = Image.new("RGB", (8 * 112, ((len(selection) + 7) // 8) * 132), "#dddddd")
    draw = ImageDraw.Draw(sheet)
    for i, row in enumerate(selection):
        x, y = i % 8 * 112, i // 8 * 132
        with Image.open(staging / row["image"]) as image:
            sheet.paste(image.resize((112, 112)), (x, y))
        draw.text((x + 2, y + 113), f"{i:03d} {row['provenance']['source'][:3]} {row['split']}", fill="black")
    sheet.save(staging / "audit-sheet.png")
    write_json(staging / "audit-selection.json", [{"index": i, "sample_id": r["sample_id"],
                "source": r["provenance"]["source"], "split": r["split"], "source_label": r["source_label"]}
               for i, r in enumerate(selection)])


def validate_dataset(directory: Path) -> dict:
    """完整验证发布包、记录、像素与分组隔离；待复核数据只校验，不进入监督。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS)
            or manifest.get("archives") != ARCHIVES):
        raise ValueError("字符负例发布契约不符")
    required = {*[f"{split}.jsonl" for split in SPLITS], "source-index.jsonl", "duplicate-quarantine.json",
                "audit-sheet.png", "audit-selection.json", *EVIDENCE}
    if set(manifest.get("files", {})) != required:
        raise ValueError("字符负例文件集合不符")
    for name in required:
        if file_record(directory / name) != manifest["files"][name]:
            raise ValueError(f"字符负例文件散列不符：{name}")
    for name, digest in EVIDENCE.items():
        if file_record(directory / name)["sha256"] != digest:
            raise ValueError("字符负例许可证据不符")
    with (directory / "source-index.jsonl").open() as handle:
        index = [json.loads(line) for line in handle]
    source_ids = {item["source_id"] for item in index}
    if len(source_ids) != len(index) or len(index) != manifest["source_records"]:
        raise ValueError("字符原始索引重复或数量不符")
    selected = {item["source_id"]: item for item in index if item["selected"]}
    rows, ids, groups, pixels = [], set(), {}, {}
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                row = json.loads(line)
                validate_record(row)
                original = selected.get(row["provenance"]["source_id"])
                if original is None or original["source_label"] != row["source_label"] or original["source"] != row["provenance"]["source"]:
                    raise ValueError("字符记录与原始选取索引不符")
                if row["split"] != split or row["sample_id"] in ids:
                    raise ValueError("字符样本重复或记录进入错误划分")
                ids.add(row["sample_id"])
                if split != "review":
                    if groups.setdefault(row["group_id"], split) != split:
                        raise ValueError("字符来源组跨划分")
                    if row["pixel_sha256"] in pixels:
                        raise ValueError("监督字符像素重复")
                    pixels[row["pixel_sha256"]] = split
                path = directory / row["image"]
                if file_record(path)["sha256"] != row["image_sha256"]:
                    raise ValueError("字符图像文件散列不符")
                with Image.open(path) as image:
                    if image.size != (224, 224) or image.mode != "RGB" or hashlib.sha256(image.tobytes()).hexdigest() != row["pixel_sha256"]:
                        raise ValueError("字符图像尺寸、模式或像素不符")
                rows.append(row)
    if (len(list((directory / "images").iterdir())) != len(ids) or _counts(rows) != manifest["counts"]
            or {row["provenance"]["source_id"] for row in rows} != set(selected)):
        raise ValueError("字符图像或分类计数不符")
    return manifest["counts"]


def generate_dataset(uci: Path, kanji: Path, destination: Path, kanji_per_class: int = 60) -> dict:
    """发布真实字符负例；每字类限量稳定取样，失败清理且拒绝覆盖任何既有数据包。"""
    if type(kanji_per_class) is not int or not 1 <= kanji_per_class <= 100:
        raise ValueError("Kanji每字类数量必须在1到100之间")
    sources = _verify_sources(uci, kanji)
    with publication(destination) as staging:
        (staging / "images").mkdir()
        rows, index = [], []
        for iterator in (_digit_rows(uci), _letter_rows(uci)):
            for label, paths, p in iterator:
                image = render_image(paths)
                info = {"input_kind": "original_unipen" if p["source"] == "pendigits" else "integrated_smoothed_velocity",
                        "screen_y_negated": True, "preserve_aspect_ratio": True, "padding": 16, "stroke_width": 3, "empty": False}
                rows.append(_make_row(label, paths, image, info, p, staging))
                index.append({"source": p["source"], "source_id": p["source_id"], "source_label": label,
                              "selected": True, "selection_reason": "all_source_records_with_ambiguous_classes_quarantined"})
        print(json.dumps({"state": "vectors_rendered", "records": len(rows)}), flush=True)
        for label, image, info, p in _kanji_rows(kanji, kanji_per_class, index):
            rows.append(_make_row(label, None, image, info, p, staging))
            if len(rows) % 10000 == 0:
                print(json.dumps({"state": "rasterizing", "records": len(rows)}), flush=True)
        duplicates = _isolate_duplicates(rows)
        with ExitStack() as stack:
            handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("w")) for split in SPLITS}
            for row in rows:
                validate_record(row)
                handles[row["split"]].write(json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        with (staging / "source-index.jsonl").open("w") as output:
            for info in index:
                output.write(json.dumps(info, ensure_ascii=False, separators=(",", ":")) + "\n")
        write_json(staging / "duplicate-quarantine.json", duplicates)
        _audit_sheet(staging, rows)
        for name in EVIDENCE:
            shutil.copyfile((kanji if name == "UPSTREAM.txt" else uci) / name, staging / name)
        files = {p.name: file_record(p) for p in staging.iterdir() if p.is_file()}
        manifest = {"dataset": VERSION, "classes": list(LABELS), "archives": ARCHIVES, "sources": sources,
                    "counts": _counts(rows), "source_records": len(index), "kanji_per_class_cap": kanji_per_class,
                    "files": files, "limitations": LIMITATIONS, "derived_render_views_per_record": 1,
                    "audit_policy": "固定散列每来源每划分24图抽查，非逐样本人工标注。"}
        manifest["generator_sources"] = {p.name: file_record(p)["sha256"] for p in sorted(Path(__file__).parent.glob("*.py"))}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest
