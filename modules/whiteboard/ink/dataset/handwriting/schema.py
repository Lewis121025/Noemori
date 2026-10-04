"""字符来源契约；字形提示不能覆盖视觉上与几何原语重合的歧义。"""

import hashlib
import re

from ..classification.schema import validate_paths

VERSION = "whiteboard-handwriting-negatives-v1"
SPLITS = ("train", "val", "test", "review")
ARCHIVES = {
    "pendigits.zip": "1e02bea023613c2b11c9492f6f34caf975420455934f3527d270cee9a1f03b64",
    "trajectories.zip": "5d2db017ef0d8cf0e65ed060c9e90399f78eb9f1e3cb63e22ca8c3ef4ba67d52",
    "kkanji.tar": "6c65024b7b79de6661a049c89decfddae8bb908f71fcd7fdf1bd9a7f220a1cda",
}
# 这些类别的完整输入也可能是可修复原语，字符标签不能作为other真值。
EXCLUDED_DIGITS = frozenset("01")
EXCLUDED_LETTERS = frozenset("cdlopquvy")
EXCLUDED_KANJI = frozenset("一二三丨丶丿乀乁乙乚乛亅冂冖凵匚匸口囗〇○十乂人入八厂广了丁七九儿几又小大山川工土士上下一丩乇乃乞刀力夕卜巾干于弓子才寸己已巳巛彡彳丬爿片亠冫讠丷")


def stable_hash(value: str) -> str:
    """返回UTF-8内容散列；用于稳定选取，不能当作真实书写者身份。"""
    return hashlib.sha256(value.encode()).hexdigest()


def digit_split(cohort: str, writer: int) -> str:
    """保留官方测试队列；训练队列按真实作者24/6划分，局部作者编号按队列隔离。"""
    if cohort not in ("train", "test") or type(writer) is not int or not 1 <= writer <= (30 if cohort == "train" else 14):
        raise ValueError("Pendigits队列或局部作者编号非法")
    if cohort == "test":
        return "test"
    validation = set(sorted(range(1, 31), key=lambda i: stable_hash(f"pendigits/val/{i}"))[:6])
    return "val" if writer in validation else "train"


def character_split(code: str) -> str:
    """按Unicode字类隔离Kanji；来源没有作者/书页标识，不能声称作者隔离。"""
    if not re.fullmatch(r"U\+[0-9A-F]{4,6}", code) or not 0 <= int(code[2:], 16) <= 0x10ffff:
        raise ValueError("Kanji字类标识非法")
    bucket = int(stable_hash(f"kkanji/class/{code}")[:8], 16) % 10
    return "val" if bucket == 8 else "test" if bucket == 9 else "train"


def eligible_label(source: str, label: str) -> bool:
    """判断来源类别是否能提供负监督；不把近原语字符强制映射为other。"""
    if source == "pendigits":
        return label in "0123456789" and label not in EXCLUDED_DIGITS
    if source == "character_trajectories":
        return label in "abcdeghlmnopqrsuvwyz" and label not in EXCLUDED_LETTERS
    if source == "kuzushiji_kanji":
        return len(label) == 1 and label not in EXCLUDED_KANJI
    raise ValueError("未知字符来源")


def expected_identity(provenance: dict) -> tuple[str, str | None, str]:
    """从来源标识恢复分组、作者和划分；拒绝把缺失作者伪装成独立作者。"""
    source = provenance["source"]
    if source == "pendigits":
        cohort, writer = provenance["cohort"], provenance["local_writer_id"]
        split = digit_split(cohort, writer)
        identity = f"pendigits/{cohort}/writer-{writer}"
        return identity, identity, split
    if source == "character_trajectories":
        return "character_trajectories/single_anonymous_subject", None, "train"
    if source == "kuzushiji_kanji":
        code = provenance["character_class"]
        return f"kuzushiji_kanji/{code}", None, character_split(code)
    raise ValueError("未知字符来源")


def validate_record(row: dict) -> None:
    """核验字符负监督、来源身份及几何契约；标签越界或作者/字类泄漏抛ValueError。"""
    required = {"sample_id", "group_id", "writer_id", "assigned_split", "split", "source_label", "label",
                "annotation_kind", "annotation_status", "review_reason", "image", "image_sha256",
                "pixel_sha256", "normalization", "paths", "provenance"}
    if not isinstance(row, dict) or set(row) != required:
        raise ValueError("字符记录字段不符")
    p = row["provenance"]
    source = p.get("source")
    group, writer, split = expected_identity(p)
    if (row["group_id"], row["writer_id"], row["assigned_split"]) != (group, writer, split):
        raise ValueError("字符来源分组与划分不符")
    if row["split"] not in SPLITS or (row["split"] != "review" and row["split"] != split):
        raise ValueError("字符记录划分非法")
    accepted = row["split"] != "review"
    if (row["label"] != ("other" if accepted else None)
            or row["annotation_status"] != ("accepted" if accepted else "quarantined")
            or row["annotation_kind"] != "mapped_source_character"):
        raise ValueError("字符监督类型或隔离标签非法")
    if accepted and (not eligible_label(source, row["source_label"]) or row["normalization"].get("empty")):
        raise ValueError("近原语或空白字符不得进入other监督")
    expected_archive = {"pendigits": "pendigits.zip", "character_trajectories": "trajectories.zip",
                        "kuzushiji_kanji": "kkanji.tar"}[source]
    if (p.get("archive_sha256") != ARCHIVES[expected_archive]
            or p.get("license") != ("CC-BY-SA-4.0" if source == "kuzushiji_kanji" else "CC-BY-4.0")):
        raise ValueError("字符来源归档或许可不符")
    for key, length in (("sample_id", 32), ("image_sha256", 64), ("pixel_sha256", 64)):
        if not isinstance(row[key], str) or not re.fullmatch(f"[0-9a-f]{{{length}}}", row[key]):
            raise ValueError("字符记录散列非法")
    if (row["sample_id"] != stable_hash(p["source_id"])[:32]
            or row["image"] != f"images/{row['sample_id']}.png"
            or not re.fullmatch(r"[0-9a-f]{64}", p.get("source_sha256", ""))):
        raise ValueError("字符原始身份或图像路径不符")
    if source == "kuzushiji_kanji":
        code = p["character_class"]
        if (row["paths"] is not None or row["source_label"] != chr(int(code[2:], 16))
                or not re.fullmatch(re.escape(f"kkanji2/{code}/") + r"[0-9a-f]+\.png", p["source_id"])
                or p.get("derivation") != "source_raster_inverted_aspect_preserved"):
            raise ValueError("Kanji不得虚构矢量、字类或作者")
    else:
        validate_paths(row["paths"])
        if source == "pendigits":
            expected_id = f"pendigits/{p['cohort']}/writer-{p['local_writer_id']}/{p['original_sample_id']}"
            if p["source_id"] != expected_id or p.get("derivation") != "original_unipen_screen_y_negated":
                raise ValueError("Pendigits原始采集身份不符")
        elif (not re.fullmatch(r"character_trajectories/sample-\d{4}", p["source_id"])
              or p.get("derivation") != "integrated_axis_denormalized_smoothed_velocity_screen_y_negated"):
            raise ValueError("字符速度积分必须显式溯源")
