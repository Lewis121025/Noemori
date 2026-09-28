#!/usr/bin/env python3
"""准备可追溯的真实笔迹语料，不运行或按任何待测算法的结果选样。

运行 python3 test/whiteboard/ink/dataset/prepare.py 构建语料；--verify 只校验本地数据。
--replay manifest.json 按已固定的对象版本与字节窗口重新获取，输出必须指定到新目录。
数据保留原始像素坐标、毫秒时间及重复时间戳；不以类别标签充当标准几何真值。
下载失败、来源变更、样本不足或校验失败均显式报错，完整构建前不发布输出目录。
"""

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "fixtures" / "corpus-v1"
CATEGORIES = (
    "bicycle", "bridge", "cat", "circle", "cloud", "eye", "face", "flower",
    "hand", "hexagon", "house", "lightning", "line", "square",
    "stairs", "star", "sun", "tree", "triangle", "zigzag",
)
QUOTAS = {"development": 600, "validation": 200, "holdout": 200}
SEED = "nous-ink-corpus-v1"
WINDOW_COUNT = 32
WINDOW_BYTES = 256 * 1024
LOOKAHEAD_BYTES = 64 * 1024


def canonical(value):
    """生成跨运行稳定的 JSON 字节；拒绝非有限数，供内容标识和文件校验使用。"""
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(data):
    """返回 SHA-256 十六进制校验和。"""
    return hashlib.sha256(data).hexdigest()


def split_for(content_hash):
    """按内容分组，重复绘图不会因来源 ID 不同被分到开发集和保留集。"""
    bucket = int(digest((SEED + "/split/" + content_hash).encode())[:16], 16) % 10
    return "development" if bucket < 6 else "validation" if bucket < 8 else "holdout"


def request(url, headers=None, method="GET", limit=None):
    """有界重试公开数据请求；服务端忽略 Range 或返回超量数据时终止。"""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers or {}, method=method)
            with urllib.request.urlopen(req, timeout=40) as response:
                if headers and "Range" in headers and response.status != 206:
                    raise ValueError("服务器未遵守 Range，拒绝下载整个对象")
                body = response.read(limit + 1) if limit is not None else response.read()
                if limit is not None and len(body) > limit:
                    raise ValueError("响应超过请求的字节上限")
                return dict(response.headers.items()), body
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 2:
                raise RuntimeError(f"下载失败：{url}：{error}") from error
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError("不可到达的请求状态")


def describe_source(category):
    """固定 GCS 对象代次；下载期间及重建时不静默跟随来源变化。"""
    url = f"https://storage.googleapis.com/quickdraw_dataset/full/raw/{category}.ndjson"
    headers, _ = request(url, method="HEAD")
    headers = {key.lower(): value for key, value in headers.items()}
    size = int(headers["content-length"])
    rng = random.Random(SEED + "/windows/" + category)
    windows = []
    for i in range(WINDOW_COUNT):
        lower, upper = size * i // WINDOW_COUNT, size * (i + 1) // WINDOW_COUNT
        start = rng.randrange(lower, max(lower + 1, upper - WINDOW_BYTES))
        windows.append({"start": start, "stop": min(size, start + WINDOW_BYTES)})
    return {"category": category, "url": url, "generation": headers["x-goog-generation"],
            "size": size, "etag": headers["etag"], "windows": windows}


def extract_lines(body, start, stop, object_size):
    """只选行首落在窗口内的完整记录；末行可跨窗口，避免偏向较短的绘图。"""
    position = 0 if start == 0 else body.find(b"\n") + 1
    if start != 0 and position == 0:
        raise ValueError("读取窗口不足以越过首条不完整记录")
    while start + position < stop:
        end = body.find(b"\n", position)
        if end < 0:
            if start + len(body) != object_size:
                raise ValueError("读取窗口的前瞻区不足以覆盖完整记录")
            end = len(body)
        if end > position:
            yield start + position, body[position:end]
        position = end + 1


def read_window(source, window):
    """读取固定窗口及末行前瞻；记录响应哈希，供逐字节复现检查。"""
    start, stop = window["start"], window["stop"]
    end = min(source["size"], stop + LOOKAHEAD_BYTES) - 1
    url = source["url"] + "?generation=" + source["generation"]
    headers, body = request(url, {"Range": f"bytes={start}-{end}"}, limit=end - start + 1)
    headers = {key.lower(): value for key, value in headers.items()}
    if headers.get("content-range") != f"bytes {start}-{end}/{source['size']}":
        raise ValueError("响应范围与来源版本不匹配")
    if len(body) != end - start + 1:
        raise ValueError("响应被截断")
    checksum = digest(body)
    if "sha256" in window and window["sha256"] != checksum:
        raise ValueError("同一来源代次的窗口内容发生变化")
    return {**window, "sha256": checksum}, list(extract_lines(body, start, stop, source["size"]))


def normalize_record(raw, category):
    """只转换存储排列，不平滑、删点、插值或缩放；结构错误与数值错误均拒绝。"""
    value = json.loads(raw)
    if value.get("word") != category or not isinstance(value.get("recognized"), bool):
        raise ValueError("类别或来源识别标签无效")
    identifier = str(value["key_id"])
    if not identifier.isdigit() or not value["drawing"]:
        raise ValueError("绘图 ID 或笔画为空")
    strokes = []
    for stroke in value["drawing"]:
        if len(stroke) != 3 or not stroke[0] or len({len(axis) for axis in stroke}) != 1:
            raise ValueError("笔画轴长度不一致或为空")
        points = list(map(list, zip(*stroke)))
        previous_time = -1
        for x, y, timestamp in points:
            if any(isinstance(v, bool) or not isinstance(v, (int, float))
                   or not math.isfinite(v) for v in (x, y, timestamp)):
                raise ValueError("坐标或时间不是有限数")
            if timestamp < previous_time or timestamp < 0:
                raise ValueError("时间倒退或为负")
            previous_time = timestamp
        strokes.append(points)
    content_hash = digest(canonical(strokes))
    return {"id": "quickdraw/" + category + "/" + identifier, "category": category,
            "recognized": value["recognized"], "content_sha256": content_hash,
            "strokes": strokes}


def write_gzip(path, records):
    """固定 gzip 时间与头部文件名，使同一语料重建后得到相同文件字节。"""
    with path.open("wb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as compressed:
            for record in records:
                compressed.write(canonical(record) + b"\n")


def select_category(source, results, seen_ids, seen_contents):
    """在内容哈希固定分组后按另一独立哈希排序取足额样本，完全不参考模型误差。"""
    candidates = {}
    rejected = Counter()
    source["windows"] = []
    for window, lines in results:
        source["windows"].append(window)
        for offset, raw in lines:
            try:
                record = normalize_record(raw, source["category"])
            except (ValueError, KeyError, TypeError) as error:
                rejected[str(error)] += 1
                continue
            record["source_offset"] = offset
            key = record["content_sha256"]
            if key in candidates:
                rejected["duplicate_content"] += 1
            else:
                candidates[key] = record
    chosen = {split: [] for split in QUOTAS}
    order = sorted(candidates, key=lambda key: digest((SEED + "/selection/" + key).encode()))
    for key in order:
        record = candidates[key]
        split = split_for(key)
        if record["id"] in seen_ids or key in seen_contents:
            rejected["cross_category_duplicate"] += 1
            continue
        if len(chosen[split]) < QUOTAS[split]:
            chosen[split].append(record)
            seen_ids.add(record["id"])
            seen_contents.add(key)
    for split, quota in QUOTAS.items():
        if len(chosen[split]) != quota:
            raise ValueError(f"{source['category']}/{split} 样本不足：{len(chosen[split])}/{quota}")
    source["candidate_drawings"] = len(candidates)
    source["rejected"] = dict(sorted(rejected.items()))
    return chosen


def summarize(records):
    """统计观测覆盖，不根据未知设备/作者生成标签，也不把类别视为几何真值。"""
    intervals, lengths = [], []
    stationary = duplicate_time = short = 0
    for record in records:
        for stroke in record["strokes"]:
            lengths.append(len(stroke))
            short += len(stroke) < 6
            for a, b in zip(stroke, stroke[1:]):
                dt = b[2] - a[2]
                duplicate_time += dt == 0
                stationary += a[:2] == b[:2]
                if dt > 0:
                    intervals.append(dt)
    def quantiles(values):
        values.sort()
        return {name: values[min(len(values)-1, int((len(values)-1)*fraction))]
                for name, fraction in [("p50", .5), ("p95", .95), ("p99", .99)]} if values else {}
    return {"drawings": len(records), "strokes": len(lengths), "points": sum(lengths),
            "categories": dict(sorted(Counter(r["category"] for r in records).items())),
            "recognized": sum(r["recognized"] for r in records),
            "short_strokes_below_6_points": short, "same_timestamp_pairs": duplicate_time,
            "stationary_pairs": stationary, "interval_ms": quantiles(intervals),
            "points_per_stroke": quantiles(lengths)}


def build(output, replay=None):
    """在同级临时目录完整构建后发布；失败自动清理，不留下半套语料。"""
    if output.exists():
        raise ValueError("输出目录已存在；校验请用 --verify，重建请指定新的 --output")
    previous = json.loads(replay.read_text()) if replay else None
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        sources = previous["sources"] if previous else list(pool.map(describe_source, CATEGORIES))
        jobs = [(source, window) for source in sources for window in source["windows"]]
        results = list(pool.map(lambda job: read_window(*job), jobs))
    split_records = {split: [] for split in QUOTAS}
    seen_ids, seen_contents = set(), set()
    position = 0
    for source in sources:
        count = len(source["windows"])
        chosen = select_category(source, results[position:position+count], seen_ids, seen_contents)
        position += count
        for split in QUOTAS:
            split_records[split].extend(chosen[split])
        print(source["category"], "候选", source["candidate_drawings"], "选取", sum(QUOTAS.values()), flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ink-corpus-", dir=output.parent) as temporary:
        stage = Path(temporary) / "data"
        stage.mkdir()
        files = {}
        for split, records in split_records.items():
            filename = split + ".ndjson.gz"
            write_gzip(stage / filename, records)
            files[split] = {"file": filename, "sha256": digest((stage / filename).read_bytes()),
                            **summarize(records)}
        manifest = {"schema_version": 1, "seed": SEED, "quotas_per_category": QUOTAS,
                    "sampling": "32 stratified random byte windows per category; hash-ranked content groups",
                    "attribution": "Google, Inc. / Quick, Draw! Dataset",
                    "source": "https://github.com/googlecreativelab/quickdraw-dataset",
                    "license": "https://creativecommons.org/licenses/by/4.0/",
                    "changes": "Keep x/y/time and recognized label; transpose arrays; omit country and wall-clock timestamp. No simplification, resampling or scaling.",
                    "limitations": ["No author or device IDs; no author/device-independent claim",
                                    "Category is a prompt, not geometric ground truth",
                                    "Byte-window sample is not a census or guaranteed representative of all drawings"],
                    "sources": sources, "splits": files}
        if previous and manifest != previous:
            raise ValueError("重建结果与原始清单不一致")
        (stage / "manifest.json").write_bytes(canonical(manifest) + b"\n")
        verify(stage)
        stage.rename(output)
    print(json.dumps(files, ensure_ascii=False, indent=2), flush=True)


def verify(output):
    """独立解压并复核校验和、统计、内容分组与跨集合唯一性；不读取模型评分。"""
    manifest = json.loads((output / "manifest.json").read_text())
    if manifest["schema_version"] != 1 or manifest["seed"] != SEED:
        raise ValueError("不支持的语料版本")
    if set(manifest["splits"]) != set(QUOTAS):
        raise ValueError("开发、验证或保留集合缺失")
    seen_ids, seen_contents = set(), set()
    for split, entry in manifest["splits"].items():
        if entry["categories"] != {category: QUOTAS[split] for category in CATEGORIES}:
            raise ValueError("类别配额与预先固定的抽样规则不一致")
        path = output / entry["file"]
        if path.name != entry["file"] or digest(path.read_bytes()) != entry["sha256"]:
            raise ValueError("文件名或校验和不一致")
        with gzip.open(path, "rt", encoding="utf-8") as source:
            records = [json.loads(line) for line in source]
        for record in records:
            content = digest(canonical(record["strokes"]))
            if content != record["content_sha256"] or split_for(content) != split:
                raise ValueError("内容校验和或分组错误")
            if record["id"] in seen_ids or content in seen_contents:
                raise ValueError("集合内或集合间出现重复绘图")
            seen_ids.add(record["id"])
            seen_contents.add(content)
        for key, value in summarize(records).items():
            if entry[key] != value:
                raise ValueError("清单统计不匹配：" + key)
    print("真实语料校验通过：", len(seen_ids), "幅唯一绘图", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--replay", type=Path)
    args = parser.parse_args()
    if args.verify:
        verify(args.output)
    else:
        build(args.output, args.replay)
