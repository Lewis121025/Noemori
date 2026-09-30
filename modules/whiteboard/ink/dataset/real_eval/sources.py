"""核对上游配对、作者归属和 SVG 坐标框架，不从整图伪造绘制事件。"""

from collections import Counter
import csv
from html.parser import HTMLParser
import io
import math
import re
from typing import TypedDict
from urllib.parse import quote, unquote, urljoin, urlsplit
import xml.etree.ElementTree as ET

BASE = "https://cragl.cs.gmu.edu/sketchbench/"
TAGS_URL = BASE + "Benchmark_Dataset/sketch_tags.csv"
REFERENCES_URL = BASE + "web/gt-table.html"
ROUGH_URL = BASE + "web/rough-table.html"
LICENSES = {f"CC-BY-{version}": f"https://creativecommons.org/licenses/by/{version}/"
            for version in ("2.0", "3.0", "4.0")}


class Reference(TypedDict):
    """上游人工清理版本；artist 仅作归属记录，不是模型特征。"""

    artist: str
    url: str


class Candidate(TypedDict):
    """拥有明确源图许可和多份参考稿的整图候选；不推断参考稿的额外授权。"""

    sketch_id: str
    author: str
    attribution: str
    author_homepage: str
    source: str
    genre: str
    background: str
    source_license: str
    source_license_url: str
    rough_shape_url: str
    rough_full_url: str
    references: list[Reference]


class _SvgLinks(HTMLParser):
    def __init__(self, suffix: str) -> None:
        super().__init__()
        self.links: set[str] = set()
        self.suffix = suffix

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href and href.endswith(self.suffix):
                self.links.add(urljoin(REFERENCES_URL, href))


def select_candidates(tags: bytes, reference_page: bytes) -> list[Candidate]:
    """按明确 CC BY 版本筛选全部已清理草图；重复 ID、错源链接或少于两份参考时报错。"""
    parser = _SvgLinks("_norm_cleaned.svg")
    parser.feed(reference_page.decode("utf-8"))
    prefix = BASE + "Benchmark_Dataset/GT/"
    if any(not link.startswith(prefix) or "/" in unquote(link[len(prefix):])
           for link in parser.links):
        raise ValueError("参考稿链接超出上游 GT 目录")
    rows = csv.DictReader(io.StringIO(tags.decode("utf-8-sig")))
    required = {"Name", "Author", "Preferred Attribution", "Author Homepage", "Copyright",
                "Source", "Genre", "Background", "Cleaned"}
    if not required <= set(rows.fieldnames or []):
        raise ValueError("上游标签表缺少必要字段")
    result: list[Candidate] = []
    seen: set[str] = set()
    for row in rows:
        identifier = row["Name"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier) or identifier in seen:
            raise ValueError("上游草图 ID 非法或重复")
        seen.add(identifier)
        if row["Cleaned"].lower() != "yes" or row["Copyright"] not in LICENSES:
            continue
        references: list[Reference] = []
        for link in sorted(parser.links):
            filename = unquote(urlsplit(link).path.rsplit("/", 1)[-1])
            if filename.startswith(identifier + "_"):
                artist = filename[len(identifier) + 1:-len("_norm_cleaned.svg")]
                if not artist:
                    raise ValueError("参考稿缺少清理者归属")
                references.append({"artist": artist, "url": link})
        if len(references) < 2:
            raise ValueError(f"{identifier} 缺少多参考配对")
        rough = BASE + "Benchmark_Dataset/Rough/SVG/" + quote(identifier)
        result.append({"sketch_id": identifier, "author": row["Author"],
                       "attribution": row["Preferred Attribution"] or row["Author"],
                       "author_homepage": row["Author Homepage"], "source": row["Source"],
                       "genre": row["Genre"], "background": row["Background"],
                       "source_license": row["Copyright"],
                       "source_license_url": LICENSES[row["Copyright"]],
                       "rough_shape_url": rough + "_norm_rough.svg",
                       "rough_full_url": rough + "_norm_full.svg", "references": references})
    if not result:
        raise ValueError("没有符合选择条件的真实评测配对")
    return sorted(result, key=lambda item: item["sketch_id"])


def available_candidates(candidates: list[Candidate], rough_page: bytes) -> tuple[list[Candidate], list[dict[str, str]]]:
    """根据上游公开的输入链接筛选，并逐条记录缺失变体；不凭命名规则假造文件存在。"""
    parser = _SvgLinks(".svg")
    parser.feed(rough_page.decode("utf-8"))
    available: list[Candidate] = []
    excluded: list[dict[str, str]] = []
    for candidate in candidates:
        missing = [field for field in ("rough_shape_url", "rough_full_url") if candidate[field] not in parser.links]
        if missing:
            excluded.append({"sketch_id": candidate["sketch_id"],
                             "reason": "上游输入列表未提供所需变体：" + ", ".join(missing)})
        else:
            available.append(candidate)
    if not available:
        raise ValueError("上游没有可用的形状层与全部层输入配对")
    return available, excluded


def _external_css_reference(value: str) -> bool:
    if "@import" in value.lower():
        return True
    return any(not match.strip().strip("\"'").startswith("#")
               for match in re.findall(r"url\(\s*([^)]*)\)", value, re.IGNORECASE))


def inspect_svg(data: bytes) -> dict[str, object]:
    """校验 SVG 并返回原始视框与图元数量；拒绝活动内容、外部图像和无效视框。"""
    root = ET.fromstring(data)
    svg_namespace = "http://www.w3.org/2000/svg"
    if root.tag != "{" + svg_namespace + "}svg":
        raise ValueError("文件不是 SVG")
    values = re.split(r"[\s,]+", root.attrib.get("viewBox", "").strip())
    try:
        frame = [float(value) for value in values]
    except ValueError as error:
        raise ValueError("SVG 缺少可用 viewBox") from error
    if len(frame) != 4 or not all(math.isfinite(value) for value in frame) or min(frame[2:]) <= 0:
        raise ValueError("SVG viewBox 非法")
    primitives: Counter[str] = Counter()
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag in {"script", "foreignObject", "image", "animate", "set"}:
            raise ValueError(f"SVG 包含不支持的活动或引用元素：{tag}")
        for key, value in element.attrib.items():
            local = key.rsplit("}", 1)[-1]
            if local.lower().startswith("on") or (local == "href" and not value.startswith("#")):
                raise ValueError("SVG 包含活动属性或外部引用")
            if _external_css_reference(value):
                raise ValueError("SVG 包含外部样式引用")
        if tag == "style" and element.text and _external_css_reference(element.text):
            raise ValueError("SVG 样式依赖外部或未核验资源")
        if tag in {"path", "polyline", "polygon", "line", "circle", "ellipse", "rect"}:
            primitives[tag] += 1
    if not primitives:
        raise ValueError("SVG 没有几何图元")
    return {"view_box": frame, "primitives": dict(primitives)}
