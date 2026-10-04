"""在原分类包上追加明确参数覆盖；原测试/review逐字节保留，诊断图形独立发布。"""

import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import random
import shutil

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION

from .acquire import file_record, publication, write_json
from .coverage import COVERAGE_VERSION, GeometrySpec, coverage_specs, diagnostic_specs, make_paths, make_sample, representations
from .generate import _counts, validate_dataset
from .render import render_image
from .schema import LABELS, SPLITS, content_hash
from .sources import _geometry

DIAGNOSTIC_VERSION = "clean-geometry-diagnostic-v1"


def _png(paths, width):
    output = io.BytesIO()
    render_image(paths, width).save(output, format="PNG")
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def _rows(directory):
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            yield from (json.loads(line) for line in handle)


def _preview(destination, items, columns):
    sheet = Image.new("RGB", (224 * columns, 248 * ((len(items) + columns - 1) // columns)), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for index, (data, caption) in enumerate(items):
        x, y = index % columns * 224, index // columns * 248
        with Image.open(io.BytesIO(data)) as image:
            sheet.paste(image, (x, y))
        draw.text((x + 5, y + 227), caption, fill="black")
    sheet.save(destination)


def generate_diagnostics(destination: Path) -> dict:
    """发布108个固定七类干净诊断对象；不提供训练划分，非空目标及依赖错误抛 ValueError。"""
    if PILLOW_VERSION != "12.1.0":
        raise ValueError("要求 pillow==12.1.0")
    cases, previews = [], []
    with publication(destination) as staging:
        (staging / "images").mkdir()
        for spec in diagnostic_specs():
            for mode in representations(spec):
                paths = make_paths(spec, mode)
                for width in (1, 3, 6):
                    identifier = f"{spec.name}/{mode}/width-{width}"
                    data, digest = _png(paths, width)
                    image_name = f"images/{content_hash(identifier)[:32]}.png"
                    (staging / image_name).write_bytes(data)
                    cases.append({"case_id": identifier, "label": spec.label, "paths": paths,
                                  "parameters": spec.parameters, "rotation_degrees": spec.rotation_degrees,
                                  "representation": mode, "stroke_width": width,
                                  "image": image_name, "image_sha256": digest})
                    if width == 3 and mode in ("native", "closed"):
                        previews.append((data, spec.name))
        with (staging / "cases.jsonl").open("w") as handle:
            for case in cases:
                handle.write(json.dumps(case, ensure_ascii=False, separators=(",", ":")) + "\n")
        _preview(staging / "preview.png", previews, 4)
        manifest = {"schema_version": 1, "dataset": DIAGNOSTIC_VERSION, "classes": list(LABELS),
                    "counts": {"cases": len(cases), "by_label": dict(Counter(c["label"] for c in cases))},
                    "protocol": "固定参数七类干净基础图形；线宽1/3/6；矩形含闭合、分边、边中点起笔。预先定义，不参考预测。",
                    "training_policy": "独立接入诊断，不进入训练或验证选模；训练补充排除与本包逐字节相同的图像。",
                    "limitations": ["这是合成几何的接入一致性检查，不证明真实手绘泛化。",
                                    "标准方形等理想图形天然具有几何等价性，不把改变绝对大小当成独立视觉证据。"],
                    "render": {"pillow": PILLOW_VERSION, "size": [224, 224], "mode": "RGB", "preserve_aspect_ratio": True},
                    "files": {name: file_record(staging / name) for name in ("cases.jsonl", "preview.png")}}
        write_json(staging / "manifest.json", manifest)
        validate_diagnostics(staging)
    return manifest


def validate_diagnostics(directory: Path) -> dict:
    """核验诊断参数、路径和实际图片一致；样本数、参数契约或文件损坏抛 ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != DIAGNOSTIC_VERSION or manifest.get("classes") != list(LABELS):
        raise ValueError("诊断数据版本或类别不符")
    for name in ("cases.jsonl", "preview.png"):
        if file_record(directory / name) != manifest["files"][name]:
            raise ValueError("诊断文件散列不符")
    specifications = {s.name: s for s in diagnostic_specs()}
    cases, ids = [], set()
    with (directory / "cases.jsonl").open() as handle:
        for line in handle:
            case = json.loads(line)
            name, mode, width_text = case["case_id"].split("/")
            spec = specifications[name]
            width = case["stroke_width"]
            if (case["case_id"] in ids or width not in (1, 3, 6) or width_text != f"width-{width}"
                    or case["representation"] != mode or mode not in representations(spec)
                    or case["label"] != spec.label or case["parameters"] != spec.parameters
                    or case["rotation_degrees"] != spec.rotation_degrees or case["paths"] != make_paths(spec, mode)):
                raise ValueError("诊断几何参数不符或重复")
            ids.add(case["case_id"])
            _, expected_hash = _png(case["paths"], width)
            expected_image = f"images/{content_hash(case['case_id'])[:32]}.png"
            if (case["image"] != expected_image or case["image_sha256"] != expected_hash
                    or file_record(directory / expected_image)["sha256"] != expected_hash):
                raise ValueError("诊断图片与协议参数不符")
            cases.append(case)
    counts = {"cases": len(cases), "by_label": dict(Counter(c["label"] for c in cases))}
    if counts != manifest["counts"] or len(cases) != 108:
        raise ValueError("诊断覆盖数量不符")
    return counts


def _supplement(staging, diagnostics, parent_rows):
    with (diagnostics / "cases.jsonl").open() as handle:
        diagnostic_hashes = {json.loads(line)["image_sha256"] for line in handle}
    image_splits = {row["image_sha256"]: row["sample"]["split"] for row in parent_rows}
    if diagnostic_hashes.intersection(digest for digest, split in image_splits.items() if split != "review"):
        raise ValueError("诊断图像与原始包重复，需要先明确诊断独立性")
    rows, metadata, exclusions, previews = [], [], [], {}
    diagnostic_sources = {content_hash(spec.contract()) for spec in diagnostic_specs()}
    for spec in coverage_specs():
        for mode in representations(spec):
            for width in range(1, 7):
                for variant in (0, 1):
                    sample, parameters = make_sample(spec, mode, width, variant)
                    split = sample["split"]
                    if sample["provenance"]["source_sha256"] in diagnostic_sources:
                        exclusions.append({**parameters, "reason": "与独立诊断共享明确母图参数，全部表示/线宽/噪声变体一并隔离。"})
                        continue
                    if split == "test":
                        exclusions.append({**parameters, "reason": "母图哈希落入test桶；本补充仅追加train/val，不产生新测试样本。"})
                        continue
                    data, digest = _png(sample["paths"], width)
                    if digest in diagnostic_hashes:
                        exclusions.append({**parameters, "reason": "与预先保留的独立诊断图像完全相同。", "image_sha256": digest})
                        continue
                    if digest in image_splits and image_splits[digest] != split:
                        exclusions.append({**parameters, "reason": "与其他划分已有图像完全相同，保留原划分。", "image_sha256": digest})
                        continue
                    image_splits[digest] = split
                    image_name = f"images/{sample['sample_id']}.png"
                    path = staging / image_name
                    if path.exists():
                        raise ValueError("补充ID与已有样本重复")
                    path.write_bytes(data)
                    rows.append({"sample": sample, "image": image_name, "image_sha256": digest})
                    metadata.append(parameters)
                    previews.setdefault((spec.label, width), (data, f"{spec.label} / width {width}"))
    _preview(staging / "coverage-preview.png", [previews[key] for key in sorted(previews)], 6)
    return rows, metadata, exclusions


def _parent_diagnostic_audit(rows):
    sources = {}
    for row in rows:
        sample = row["sample"]
        if sample["provenance"]["kind"] == "procedural":
            sources.setdefault(sample["group_id"], sample)
    verified, unmatched, squares, circles = [], [], [], []
    for group, sample in sources.items():
        paths = _geometry(sample["label"], random.Random(group))
        if content_hash(paths) != sample["provenance"]["source_sha256"]:
            unmatched.append(group)
            continue
        verified.append(group)
        if sample["label"] == "circle":
            circles.append(group)
        elif sample["label"] == "rectangle":
            points = [p for path in paths for p in path]
            width, height = [max(p[i] for p in points) - min(p[i] for p in points) for i in (0, 1)]
            if abs(width - height) <= 1e-10:
                squares.append(group)
    return {"verified_procedural_mother_groups": len(verified), "unmatched_groups": unmatched,
            "ideal_square_groups": squares, "ideal_circle_groups": circles,
            "interpretation": "原父包确有理想方形/圆母图，旋转缩放后与标准诊断几何可能同构；这些原数据不改。诊断只作固定接入验收，不声称未见形状或独立真实泛化。新增补充才严格排除相同诊断参数母图及同像素。"}


def generate_coverage_dataset(parent: Path, diagnostics: Path, destination: Path) -> dict:
    """复制已校验父包并仅追加train/val；保留原行/图像和review/test字节，诊断同图排除后原子发布。"""
    validate_dataset(parent)
    validate_diagnostics(diagnostics)
    parent_manifest = json.loads((parent / "manifest.json").read_text())
    parent_rows = list(_rows(parent))
    with publication(destination) as staging:
        for path in parent.iterdir():
            target = staging / path.name
            if path.is_dir():
                shutil.copytree(path, target)
            elif path.name != "manifest.json":
                shutil.copyfile(path, target)
        shutil.copyfile(parent / "manifest.json", staging / "parent-manifest.json")
        added, parameters, excluded = _supplement(staging, diagnostics, parent_rows)
        with (diagnostics / "cases.jsonl").open() as handle:
            diagnostic_hashes = {json.loads(line)["image_sha256"] for line in handle}
        review_overlap = [{"sample_id": row["sample"]["sample_id"], "image_sha256": row["image_sha256"]}
                          for row in parent_rows if row["sample"]["split"] == "review" and row["image_sha256"] in diagnostic_hashes]
        with ExitStack() as stack:
            handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("a")) for split in ("train", "val")}
            for row in added:
                handles[row["sample"]["split"]].write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        with (staging / "coverage-parameters.jsonl").open("w") as handle:
            for record in parameters:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        write_json(staging / "coverage-excluded.json", excluded)
        manifest = dict(parent_manifest)
        names = [*parent_manifest["files"], "parent-manifest.json", "coverage-parameters.jsonl", "coverage-excluded.json", "coverage-preview.png"]
        manifest.update({"counts": _counts([*parent_rows, *added]),
                         "files": {name: file_record(staging / name) for name in names},
                         "parent": {"path": str(parent.resolve()), "manifest_sha256": file_record(parent / "manifest.json")["sha256"],
                                    "review_sha256": file_record(parent / "review.jsonl")["sha256"],
                                    "preserved_samples": len(parent_rows)},
                         "coverage": {"version": COVERAGE_VERSION, "added_counts": _counts(added), "excluded_candidates": len(excluded),
                                      "linewidths": list(range(1, 7)), "noise_severities": [0, .002],
                                      "group_policy": "几何参数和朝向决定母图组；所有表示/线宽/噪声同组；原哈希test桶不导出。",
                                      "diagnostics_path": str(diagnostics.resolve()),
                                      "diagnostics_manifest_sha256": file_record(diagnostics / "manifest.json")["sha256"],
                                      "diagnostic_review_overlap": review_overlap,
                                      "parent_diagnostic_audit": _parent_diagnostic_audit(parent_rows),
                                      "review_overlap_policy": "原review保持隔离；已列出的理想图形同图记录不得再进入训练或选模。",
                                      "selection_policy": "固定参数网格；无模型推理或预测选样。"},
                         "coverage_generator_sources": {name: file_record(Path(__file__).parent / name)["sha256"]
                                                        for name in ("coverage.py", "coverage_package.py", "render.py")}})
        write_json(staging / "manifest.json", manifest)
        validate_coverage_dataset(staging, parent, diagnostics)
    return manifest


def validate_coverage_dataset(directory: Path, parent: Path, diagnostics: Path) -> dict:
    """核验v3兼容原契约、原包字节保留、补充几何参数可复现及诊断隔离；不符时抛 ValueError。"""
    result = validate_dataset(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["parent"]["manifest_sha256"] != file_record(parent / "manifest.json")["sha256"]:
        raise ValueError("父manifest变化")
    original_rows = list(_rows(parent))
    original_ids = {row["sample"]["sample_id"] for row in original_rows}
    for split in SPLITS:
        old, new = (parent / f"{split}.jsonl").read_bytes(), (directory / f"{split}.jsonl").read_bytes()
        if (split in ("test", "review") and old != new) or not new.startswith(old):
            raise ValueError("原有划分记录未逐字节保留")
    for row in original_rows:
        if (directory / row["image"]).read_bytes() != (parent / row["image"]).read_bytes():
            raise ValueError("原始图片被改变")
    rows = {row["sample"]["sample_id"]: row for row in _rows(directory)}
    with (directory / "coverage-parameters.jsonl").open() as handle:
        parameters = [json.loads(line) for line in handle]
    if {p["sample_id"] for p in parameters} != set(rows) - original_ids or len(parameters) != len(rows) - len(original_ids):
        raise ValueError("补充参数与新增样本不一一对应")
    with (diagnostics / "cases.jsonl").open() as handle:
        diagnostic_hashes = {json.loads(line)["image_sha256"] for line in handle}
    if diagnostic_hashes.intersection(row["image_sha256"] for row in rows.values() if row["sample"]["split"] != "review"):
        raise ValueError("诊断图像进入分类数据")
    for record in parameters:
        row = rows[record["sample_id"]]
        spec = GeometrySpec(record["case_name"], record["label"], record["parameters"], record["rotation_degrees"])
        sample, expected = make_sample(spec, record["representation"], record["stroke_width"], row["sample"]["provenance"]["variant"])
        if content_hash(spec.contract()) in {content_hash(s.contract()) for s in diagnostic_specs()}:
            raise ValueError("诊断母图变体进入补充训练")
        if sample != row["sample"] or expected != record or sample["split"] not in ("train", "val"):
            raise ValueError("补充几何不能从参数复现")
    return result


def main() -> None:
    """执行独立诊断生成或v3追加/核验；参数或数据错误转换为非零退出状态。"""
    parser = argparse.ArgumentParser(description="补充干净基础几何覆盖，保留已有分类数据")
    commands = parser.add_subparsers(dest="command", required=True)
    diagnostic = commands.add_parser("diagnostics")
    diagnostic.add_argument("--output", type=Path, required=True)
    for name in ("generate", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--parent", type=Path, required=True)
        command.add_argument("--diagnostics", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "diagnostics":
            result = generate_diagnostics(args.output)["counts"]
        elif args.command == "generate":
            result = generate_coverage_dataset(args.parent, args.diagnostics, args.output)["coverage"]["added_counts"]
        else:
            result = validate_coverage_dataset(args.output, args.parent, args.diagnostics)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
