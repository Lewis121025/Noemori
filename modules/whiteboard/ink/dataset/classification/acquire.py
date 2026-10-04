"""限量下载 QuickDraw 简化矢量前缀，保留原字节、标签局限与来源校验和。"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Iterator
import urllib.request

from .schema import VERSION
from .sources import QUICKDRAW_LABELS


def file_record(path: Path) -> dict:
    """返回文件字节数和 SHA-256；读取失败原样传播，不把缺失文件记为成功。"""
    with path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    return {"bytes": path.stat().st_size, "sha256": digest}


def write_json(path: Path, value: object) -> None:
    """写入可审查 UTF-8 JSON；非有限数拒绝序列化，I/O 异常原样传播。"""
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


@contextmanager
def publication(destination: Path) -> Iterator[Path]:
    """提供临时发布目录，成功才原子移动；拒绝覆盖非空目录并自动清理失败产物。"""
    if destination.is_symlink() or (destination.exists() and
                                   (not destination.is_dir() or any(destination.iterdir()))):
        raise ValueError("拒绝覆盖非空目录、文件或符号链接")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".classification-build-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "data"
        staging.mkdir()
        yield staging
        os.replace(staging, destination)


def acquire_quickdraw(destination: Path, count: int = 200) -> dict:
    """每类下载前 count 条原始记录并保存许可声明；不按 recognized 筛选，网络/格式失败不发布。"""
    if type(count) is not int or not 1 <= count <= 2000:
        raise ValueError("每类下载数必须在 1 到 2000 之间")
    with publication(destination) as staging:
        files = {}
        for category in QUICKDRAW_LABELS:
            url = f"https://storage.googleapis.com/quickdraw_dataset/full/simplified/{category}.ndjson"
            path = staging / f"{category}.ndjson"
            total = 0
            with urllib.request.urlopen(url, timeout=35) as response, path.open("wb") as output:
                for _ in range(count):
                    line = response.readline(1_000_001)
                    total += len(line)
                    if not line.endswith(b"\n") or len(line) > 1_000_000 or total > 16_000_000:
                        raise ValueError("QuickDraw 记录不完整或超过下载预算")
                    record = json.loads(line)
                    if record.get("word") != category:
                        raise ValueError("下载的 QuickDraw 类别不符")
                    output.write(line)
                etag = response.headers.get("ETag")
            files[path.name] = {**file_record(path), "url": url, "records": count, "etag": etag}
        url = "https://raw.githubusercontent.com/googlecreativelab/quickdraw-dataset/master/README.md"
        with urllib.request.urlopen(url, timeout=35) as response:
            attribution = response.read(200_001)
        if len(attribution) > 200_000 or b"https://creativecommons.org/licenses/by/4.0/" not in attribution:
            raise ValueError("上游 QuickDraw 许可声明不符")
        path = staging / "UPSTREAM.txt"
        path.write_bytes(attribution)
        files[path.name] = {**file_record(path), "url": url}
        manifest = {"schema_version": 1, "source": "quickdraw-simplified-prefix-v1", "tool_version": VERSION,
                    "count_per_category": count, "categories": list(QUICKDRAW_LABELS), "files": files,
                    "license": "CC-BY-4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
                    "attribution": "Google, The Quick, Draw! Dataset；原作者为 Quick, Draw! 游戏参与者。",
                    "selection": "每类文件前 N 条，不按 recognized 筛选；非随机子集，不保证人群代表性。",
                    "label_policy": "word 是绘制提示词，recognized 是旧游戏判断；未经人工复核，全部进入 review。"}
        write_json(staging / "manifest.json", manifest)
        verify_quickdraw(staging)
    return manifest


def verify_quickdraw(directory: Path) -> dict:
    """核验下载快照的全部原文件与许可；版本、缺失或散列不符抛 ValueError/OSError。"""
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("source") != "quickdraw-simplified-prefix-v1" or manifest.get("license") != "CC-BY-4.0"
            or manifest.get("categories") != list(QUICKDRAW_LABELS)):
        raise ValueError("QuickDraw 来源清单不符")
    for name in [*(f"{category}.ndjson" for category in QUICKDRAW_LABELS), "UPSTREAM.txt"]:
        expected = manifest["files"][name]
        actual = file_record(directory / name)
        if any(actual[key] != expected[key] for key in actual):
            raise ValueError(f"QuickDraw 文件散列不符：{name}")
        if name.endswith(".ndjson"):
            with (directory / name).open() as handle:
                count = sum(1 for _ in handle)
            if count != expected["records"] or count != manifest["count_per_category"]:
                raise ValueError(f"QuickDraw 条数不符：{name}")
    return manifest
