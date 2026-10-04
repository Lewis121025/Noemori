"""发布可直接训练的静态 PNG 与原始几何索引；未复核真实样本始终隔离。"""

from collections import Counter
from contextlib import ExitStack
import json
from pathlib import Path
import shutil

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION

from .acquire import file_record, publication, verify_quickdraw, write_json
from .render import IMAGE_SIZE, render_image
from .schema import LABELS, SPLITS, VERSION, content_hash, validate_sample
from .sources import QUICKDRAW_LABELS, quickdraw_sample, reference_samples, synthetic_samples

LIMITATIONS = [
    "train/val/test 仅含合成样本，同生成器测试不证明真实手绘泛化，不能据此宣称产品质量。",
    "QuickDraw 的类别提示词不是人工图形标注，recognized 也不是标签真值；全部留在 review。",
    "QuickDraw 仅取每类文件前缀，并非随机或按绘制者隔离的代表性子集，没有可靠绘制者 ID。",
    "尚缺真实椭圆、圆弧、非正方形矩形、箭头、文字和涂划；other 仅覆盖少量明确非目标图形。",
    "首版 arc 严格指圆弧；ellipse 合成轴比为 0.35 至 0.8，近圆歧义带没有可靠监督。",
    "识别对象必须事先分组；只包含完整图形，不解决区域分组或停笔时图形尚未画完的判断。",
    "合成扰动未根据真实设备校准，固定黑白线宽不覆盖压力/笔刷风格；上线前必须补真实采集。",
    "没有读取既有 real-eval 数据，也没有把局部修复配对的 primitive 当作完整图形标签。",
]


def _samples(seed, groups, references, quickdraw, exclusions):
    yield from synthetic_samples(seed, groups)
    if references is not None:
        yield from reference_samples(references, seed)
    if quickdraw is not None:
        for category in QUICKDRAW_LABELS:
            with (quickdraw / f"{category}.ndjson").open() as handle:
                for number, line in enumerate(handle, 1):
                    record = json.loads(line)
                    try:
                        sample = quickdraw_sample(record, category)
                    except ValueError as error:
                        exclusions.append({"source": category, "line": number, "key_id": record.get("key_id"),
                                           "reason": str(error)})
                        continue
                    yield sample


def _counts(rows):
    total, by_label, recognized = Counter(), Counter(), Counter()
    groups = {split: set() for split in SPLITS}
    for row in rows:
        sample = row["sample"]
        split, kind = sample["split"], sample["provenance"]["kind"]
        total[split] += 1
        by_label[(split, kind, sample["label"])] += 1
        groups[split].add(sample["group_id"])
        if kind == "quickdraw":
            recognized[str(sample["provenance"]["recognized"]).lower()] += 1
    return {"samples": sum(total.values()), "splits": {split: total[split] for split in SPLITS},
            "groups": {split: len(value) for split, value in groups.items()},
            "by_split_kind_label": {split: {kind: {label: by_label[(split, kind, label)] for label in LABELS}
                                              for kind in ("procedural", "tabler", "quickdraw")} for split in SPLITS},
            "quickdraw_recognized": dict(recognized)}


def _write_samples(staging, samples):
    (staging / "images").mkdir()
    rows, previews = [], {}
    with ExitStack() as stack:
        handles = {split: stack.enter_context((staging / f"{split}.jsonl").open("w")) for split in SPLITS}
        for sample in samples:
            validate_sample(sample)
            width = 2 + int(content_hash(sample["sample_id"])[:8], 16) % 3
            rendered = render_image(sample["paths"], width)
            name = f"images/{sample['sample_id']}.png"
            path = staging / name
            if path.exists():
                raise ValueError("重复样本 ID，拒绝覆盖图片")
            rendered.save(path)
            row = {"sample": sample, "image": name, "image_sha256": file_record(path)["sha256"]}
            handles[sample["split"]].write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
            rows.append(row)
            key = (sample["label"], sample["provenance"]["kind"])
            bucket = previews.setdefault(key, [])
            if len(bucket) < 4:
                bucket.append((rendered, f"{sample['label']} / {sample['provenance']['kind']}"))
    entries = [entry for key in sorted(previews) for entry in previews[key]]
    sheet = Image.new("RGB", (IMAGE_SIZE * 4, (IMAGE_SIZE + 24) * ((len(entries) + 3) // 4)), "white")
    draw = ImageDraw.Draw(sheet)
    for index, (rendered, caption) in enumerate(entries):
        x, y = index % 4 * IMAGE_SIZE, index // 4 * (IMAGE_SIZE + 24)
        sheet.paste(rendered, (x, y))
        draw.text((x + 8, y + IMAGE_SIZE + 4), caption, fill="black")
    sheet.save(staging / "preview.png")
    return _counts(rows)


def validate_dataset(directory: Path) -> dict:
    """核验全部 PNG、JSONL、标签及来源组隔离，返回统计；损坏、重复、跨划分报错。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("dataset") != VERSION or manifest.get("classes") != list(LABELS):
        raise ValueError("分类数据版本或类别顺序不符")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or file_record(directory / name) != expected:
            raise ValueError(f"文件散列或路径不符：{name}")
    ids, groups, source_groups, image_splits, rows = set(), {}, {}, {}, []
    for split in SPLITS:
        with (directory / f"{split}.jsonl").open() as handle:
            for line in handle:
                row = json.loads(line)
                if set(row) != {"sample", "image", "image_sha256"}:
                    raise ValueError("图像索引字段不符")
                sample = row["sample"]
                validate_sample(sample)
                identifier, group = sample["sample_id"], sample["group_id"]
                if sample["split"] != split or groups.setdefault(group, split) != split:
                    raise ValueError("来源组跨划分")
                source = (sample["provenance"]["kind"], sample["provenance"]["source_id"])
                if source_groups.setdefault(source, group) != group:
                    raise ValueError("同一原始对象被分到多个来源组")
                if identifier in ids or row["image"] != f"images/{identifier}.png":
                    raise ValueError("样本重复或图像路径不符")
                ids.add(identifier)
                path = directory / row["image"]
                image_hash = file_record(path)["sha256"]
                if image_hash != row["image_sha256"]:
                    raise ValueError("图片散列不符")
                if image_splits.setdefault(image_hash, split) != split:
                    raise ValueError("完全相同的图片跨划分")
                with Image.open(path) as image:
                    if image.size != (IMAGE_SIZE, IMAGE_SIZE) or image.mode != "RGB":
                        raise ValueError("图片尺寸或通道不符")
                    image.verify()
                rows.append(row)
    actual = _counts(rows)
    if actual != manifest["counts"] or len(list((directory / "images").iterdir())) != len(ids):
        raise ValueError("manifest 数量或图像数量不符")
    return actual


def generate_dataset(destination: Path, seed: int = 20261004, groups: int = 160,
                     references: Path | None = None, quickdraw: Path | None = None) -> dict:
    """原子生成带溯源的分类数据包；默认每类 160 组，不覆盖旧数据，验证失败不发布。"""
    if PILLOW_VERSION != "12.1.0":
        raise ValueError("要求固定栅格化依赖 pillow==12.1.0")
    sources, exclusions = {}, []
    if quickdraw is not None:
        sources["quickdraw"] = verify_quickdraw(quickdraw)
    with publication(destination) as staging:
        counts = _write_samples(staging, _samples(seed, groups, references, quickdraw, exclusions))
        names = [*(f"{split}.jsonl" for split in SPLITS), "preview.png"]
        if references is not None:
            sources["geometry_reference"] = json.loads((references / "manifest.json").read_text())
            shutil.copyfile(references / "LICENSE.tabler", staging / "LICENSE.tabler")
            names.append("LICENSE.tabler")
        if quickdraw is not None:
            shutil.copyfile(quickdraw / "UPSTREAM.txt", staging / "ATTRIBUTION.quickdraw.txt")
            names.append("ATTRIBUTION.quickdraw.txt")
        write_json(staging / "excluded.json", exclusions)
        names.append("excluded.json")
        package = Path(__file__).parent
        code = [*sorted(package.glob("*.py")), package.parent / "geometry.py"]
        manifest = {"schema_version": 1, "dataset": VERSION, "classes": list(LABELS),
                    "config": {"seed": seed, "groups_per_class": groups, "variants_per_group": 3},
                    "render": {"size": [224, 224], "mode": "RGB", "padding": 16, "background": "white",
                               "foreground": "black", "preserve_aspect_ratio": True, "pillow": PILLOW_VERSION,
                               "model_preprocessing": "PNG 尚未做张量归一化；训练/推理必须共享等比预处理。"},
                    "split_policy": {"procedural": "SHA-256(shape-classification-v1|group_id) 前16位模100，80/10/10",
                                     "tabler": "保留原来源族与 train 划分，所有旋转/扰动同组",
                                     "quickdraw": "按 key_id 分组；未人工确认的提示标签全部进入 review",
                                     "augmentation": "来源先分组划分，增强不跨划分"},
                    "counts": counts, "excluded_records": len(exclusions), "sources": sources,
                    "files": {name: file_record(staging / name) for name in names},
                    "generator_sources": {str(path.relative_to(package.parent)): file_record(path)["sha256"] for path in code},
                    "limitations": LIMITATIONS}
        write_json(staging / "manifest.json", manifest)
        validate_dataset(staging)
    return manifest
