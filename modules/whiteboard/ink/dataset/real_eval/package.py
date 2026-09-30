"""下载并原子发布独立真实整图评测集，保留多参考答案和逐文件溯源。"""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import html
import json
import os
from pathlib import Path
import ssl
import tempfile
from urllib.error import URLError
from urllib.request import urlopen

from .sources import (BASE, LICENSES, REFERENCES_URL, ROUGH_URL, TAGS_URL,
                      Candidate, available_candidates, inspect_svg, select_candidates)

CA_URL = "http://crt.sectigo.com/InCommonRSAServerCA2.crt"
VERSION = "rough-sketch-real-eval-v1.0.0"
MAX_FILE_BYTES = 15_000_000
FRAME_TOLERANCE = 1e-6


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def fetch(url: str, context: ssl.SSLContext | None = None) -> bytes:
    """在大小与超时上限内读取公开资源；重试三次后传播网络异常，始终核验 HTTPS。"""
    for attempt in range(3):
        try:
            with urlopen(url, context=context, timeout=30) as response:
                data = response.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise ValueError("上游文件超过 15 MB 上限")
            return data
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
    raise RuntimeError("下载重试意外结束")


def _transport() -> tuple[ssl.SSLContext, bytes]:
    # 上游未发送中间证书。补齐证书链后仍由系统根证书验证签名、主机名和有效期。
    certificate = fetch(CA_URL)
    pem = ssl.DER_cert_to_PEM_cert(certificate).encode("ascii")
    context = ssl.create_default_context()
    context.load_verify_locations(cadata=pem.decode("ascii"))
    return context, pem


def _asset(url: str, relative: str, destination: Path, context: ssl.SSLContext) -> dict[str, object]:
    data = fetch(url, context)
    try:
        geometry = inspect_svg(data)
    except ValueError as error:
        raise ValueError(f"{url}: {error}") from error
    path = destination / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": relative, "url": url, "bytes": len(data), "sha256": _hash(data), **geometry}


def _same_frame(left: list[float], right: list[float]) -> bool:
    # 上游将同一画布写成 1760 和 1759.999932；只容忍序列化舍入，不改坐标、不做配准。
    tolerance = max(left[2:]) * FRAME_TOLERANCE
    return len(left) == len(right) == 4 and all(abs(a - b) <= tolerance for a, b in zip(left, right))


def _record(candidate: Candidate, destination: Path, context: ssl.SSLContext) -> dict[str, object]:
    identifier = candidate["sketch_id"]
    prefix = f"svg/{identifier}/"
    rough = _asset(candidate["rough_shape_url"], prefix + "rough-shape.svg", destination, context)
    full = _asset(candidate["rough_full_url"], prefix + "rough-full.svg", destination, context)
    references = []
    for index, item in enumerate(candidate["references"]):
        reference = _asset(item["url"], prefix + f"reference-{index + 1}.svg", destination, context)
        references.append({"artist": item["artist"], **reference})
    same_frame = all(_same_frame(asset["view_box"], rough["view_box"]) for asset in [full, *references])
    return {"schema_version": 1, "sample_id": "rough-sketch/" + identifier,
            "split": "test" if same_frame else "review", "task": "whole_sketch_cleanup", "input": rough,
            "auxiliary_full_input": full, "references": references,
            "provenance": {key: value for key, value in candidate.items()
                           if key not in {"references", "rough_shape_url", "rough_full_url"}},
            "annotation": {"status": "upstream_artist_references", "focus_stroke_id": None,
                           "pen_up_scope_available": False,
                           "input_representation": "upstream_vector_shape_layer",
                           "tablet_trajectory_verified": False}}


def _preview(records: list[dict[str, object]], destination: Path) -> None:
    cards = []
    for record in records:
        assets = [("粗稿形状层", record["input"]), ("粗稿全部层", record["auxiliary_full_input"])]
        assets.extend(("参考：" + item["artist"], item) for item in record["references"])
        figures = ''.join(f'<figure><img src="{html.escape(item["path"])}" loading="lazy" '
                          f'alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>'
                          for label, item in assets)
        provenance = record["provenance"]
        status = "视框一致，保留用于评测" if record["split"] == "test" else "视框不一致，待核对，不进入评测"
        cards.append(f'<article><h2>{html.escape(provenance["sketch_id"])}</h2>'
                     f'<p>{status}</p>'
                     f'<p>{html.escape(provenance["genre"])} · {html.escape(provenance["attribution"])} · '
                     f'{html.escape(provenance["source_license"])}</p><div class="pair">{figures}</div></article>')
    page = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>真实草图整图评测</title><style>body{font:15px system-ui;background:#f4f6f8;'
            'color:#243144;margin:24px}article{background:white;border-radius:10px;padding:16px;margin:20px 0}'
            '.pair{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:240px}img{width:240px;height:240px;'
            'object-fit:contain;background:white}figcaption{margin-top:8px}h2{font-size:18px}</style>'
            f'<h1>真实草图整图评测 · {len(records)} 幅</h1><p>输入保留上游人工矢量化或原有矢量的形状层，'
            '同时附全部层供检查；每幅保留全部人工清理参考。视框不一致的配对单独待核对，不进入评测文件。</p>'
            '<p>这不是抬笔事件数据，没有当前笔画、局部替换范围或已验证的设备轨迹。'
            '所有 SVG 保留原始视框；不独立裁剪、缩放或人为挑选唯一答案。'
            '源图许可按上游标签表记录，不能据此推断清理参考稿的额外再授权。</p>'
            + ''.join(cards) + '</html>')
    (destination / "preview.html").write_text(page, encoding="utf-8")


def _counts(records: list[dict[str, object]]) -> dict[str, object]:
    return {"sketches": len(records), "references": sum(len(r["references"]) for r in records),
            "evaluation_sketches": sum(r["split"] == "test" for r in records),
            "evaluation_references": sum(len(r["references"]) for r in records if r["split"] == "test"),
            "review_sketches": sum(r["split"] == "review" for r in records),
            "svg_files": sum(2 + len(r["references"]) for r in records),
            "genres": dict(Counter(r["provenance"]["genre"] for r in records)),
            "source_licenses": dict(Counter(r["provenance"]["source_license"] for r in records))}


def _assets(record: dict[str, object]) -> list[dict[str, object]]:
    return [record["input"], record["auxiliary_full_input"], *record["references"]]


def validate_dataset(directory: Path) -> dict[str, object]:
    """核验配对、引用、来源和文件完整性；不符契约或篡改时抛出 ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("generator_version") != VERSION or manifest.get("role") != "evaluation_only":
        raise ValueError("真实评测 manifest 版本或角色不符")
    for relative, declared in manifest["files"].items():
        path = directory / relative
        if path.is_symlink() or directory.resolve() not in path.resolve().parents:
            raise ValueError("评测文件不能引用目录外路径或符号链接")
        data = path.read_bytes()
        if len(data) != declared["bytes"] or _hash(data) != declared["sha256"]:
            raise ValueError(f"评测文件被修改：{relative}")
    records = []
    for name, split in (("eval.jsonl", "test"), ("review.jsonl", "review")):
        subset = [json.loads(line) for line in (directory / name).read_text().splitlines()]
        if any(record["split"] != split for record in subset):
            raise ValueError("待核对配对不能混入真实评测")
        records.extend(subset)
    records.sort(key=lambda record: record["sample_id"])
    candidates, excluded = available_candidates(
        select_candidates((directory / "metadata/sketch_tags.csv").read_bytes(),
                          (directory / "metadata/reference-page.html").read_bytes()),
        (directory / "metadata/rough-page.html").read_bytes())
    if excluded != manifest["selection"]["excluded_missing_inputs"]:
        raise ValueError("缺失输入的排除记录不一致")
    expected = {candidate["sketch_id"]: candidate for candidate in candidates}
    if len(records) != len(expected) or len({r["sample_id"] for r in records}) != len(records):
        raise ValueError("真实评测样本缺失或重复")
    for record in records:
        candidate = expected[record["provenance"]["sketch_id"]]
        provenance = {key: value for key, value in candidate.items()
                      if key not in {"references", "rough_shape_url", "rough_full_url"}}
        if (record["schema_version"] != 1 or record["sample_id"] != "rough-sketch/" + candidate["sketch_id"]
                or record["provenance"] != provenance or record["split"] not in {"test", "review"}
                or record["task"] != "whole_sketch_cleanup"
                or record["annotation"] != {"status": "upstream_artist_references", "focus_stroke_id": None,
                                            "pen_up_scope_available": False,
                                            "input_representation": "upstream_vector_shape_layer",
                                            "tablet_trajectory_verified": False}):
            raise ValueError("真实评测身份、归属或任务范围被改变")
        if (record["input"]["url"] != candidate["rough_shape_url"]
                or record["auxiliary_full_input"]["url"] != candidate["rough_full_url"]
                or [{"artist": r["artist"], "url": r["url"]} for r in record["references"]] != candidate["references"]):
            raise ValueError("输入与人工参考配对错误")
        for asset in _assets(record):
            declared = manifest["files"].get(asset["path"])
            if not declared or any(asset[key] != declared[key] for key in ("sha256", "bytes")):
                raise ValueError("SVG 缺少完整性记录")
            geometry = inspect_svg((directory / asset["path"]).read_bytes())
            if any(asset[key] != geometry[key] for key in geometry):
                raise ValueError("SVG 几何统计不一致")
        same_frame = all(_same_frame(asset["view_box"], record["input"]["view_box"]) for asset in _assets(record))
        if (record["split"] == "test") != same_frame:
            raise ValueError("配对坐标框架与评测资格不一致")
    actual = _counts(records)
    if actual != manifest["counts"]:
        raise ValueError("真实评测计数不一致")
    return actual


def acquire_dataset(destination: Path) -> dict[str, object]:
    """获取全部符合许可筛选的多参考配对并原子发布；网络/契约失败不发布残缺数据。"""
    if destination.is_symlink() or (destination.exists() and
                                   (not destination.is_dir() or any(destination.iterdir()))):
        raise ValueError("拒绝覆盖非空目录、文件或符号链接")
    context, pem = _transport()
    with ThreadPoolExecutor(max_workers=3) as pool:
        tags, page, rough_page = list(pool.map(lambda url: fetch(url, context), [TAGS_URL, REFERENCES_URL, ROUGH_URL]))
    candidates, excluded = available_candidates(select_candidates(tags, page), rough_page)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".real-eval-build-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "dataset"
        (staging / "metadata").mkdir(parents=True)
        for name, data in (("sketch_tags.csv", tags), ("reference-page.html", page),
                           ("rough-page.html", rough_page), ("transport-ca.pem", pem)):
            (staging / "metadata" / name).write_bytes(data)
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda candidate: _record(candidate, staging, context), candidates))
        for filename, split in (("eval.jsonl", "test"), ("review.jsonl", "review")):
            with (staging / filename).open("w", encoding="utf-8") as handle:
                for record in records:
                    if record["split"] == split:
                        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        _preview(records, staging)
        files = {path.relative_to(staging).as_posix(): {"bytes": path.stat().st_size,
                 "sha256": _hash(path.read_bytes())} for path in sorted(staging.rglob("*")) if path.is_file()}
        manifest = {"schema_version": 1, "dataset": "nous-whiteboard-real-eval-v1",
                    "generator_version": VERSION, "role": "evaluation_only", "source": BASE,
                    "source_metadata": {"tags": TAGS_URL, "references": REFERENCES_URL, "rough_inputs": ROUGH_URL,
                                        "intermediate_certificate": CA_URL, "tls_verified": True},
                    "selection": {"cleaned": True, "source_licenses": sorted(LICENSES),
                                  "minimum_references": 2, "sampling": "all_matching_rows_with_published_inputs",
                                  "excluded_missing_inputs": excluded},
                    "coordinate_frame_check": {"relative_roundoff_tolerance": FRAME_TOLERANCE,
                                               "svg_bytes_unchanged": True, "geometric_registration": False,
                                               "mismatch_policy": "keep_in_review_jsonl_exclude_from_evaluation"},
                    "counts": _counts(records), "files": files,
                    "generator_sources": {path.name: _hash(path.read_bytes())
                                          for path in sorted(Path(__file__).parent.glob("*.py"))},
                    "limitations": ["这是整幅真实草图的公开清理基准子集，不能评测抬笔后的局部范围选择。",
                                    "矢量输入包含上游人工描摹和原有矢量，未验证为原始数位笔轨迹。",
                                    "主要输入是上游已标注的形状层；全部层另附，未自行推断哪些线条应删除。",
                                    "多份清理参考同等保留；不因某份更接近模型输出而把它当作唯一真值。",
                                    "源图 CC BY 标记来自上游标签表；参考稿的再分发权不能由源图许可推断。",
                                    "保持原 SVG 与视框，不独立居中缩放；图层语义、线宽和路径数有别于白板。",
                                    "只作评测，不进入训练；未声称代表真实白板全部用户或场景。"]}
        _json(staging / "manifest.json", manifest)
        validate_dataset(staging)
        os.replace(staging, destination)
    return manifest
