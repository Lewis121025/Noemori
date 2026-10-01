"""固定版本素材下载、许可证保留和来源族划分；失败不会被伪装成成功素材。"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

REVISION = "74929e50416e2b7c0abb8368cdc74bdcb2560ab6"
BASE_URL = f"https://raw.githubusercontent.com/tabler/tabler-icons/{REVISION}"
DEPENDENCY = "svgelements==1.9.6"

# 方向或旋转等价的素材必须同组；这是来源族隔离，并不声称所有共享图元都已隔离。
SOURCE_FAMILIES: dict[str, tuple[str, tuple[str, ...]]] = {
    "line": ("train", ("line",)),
    "round-outline": ("train", ("circle", "oval", "circle-dashed")),
    "quadrilateral": ("train", ("rectangle", "rectangle-vertical", "square", "diamond", "square-rounded")),
    "triangle": ("train", ("triangle", "triangle-inverted", "vector-triangle")),
    "polygon": ("train", ("hexagon", "pentagon", "octagon", "star", "polygon")),
    "direction-arrow": ("train", ("arrow-right", "arrow-left", "arrow-up", "arrow-down")),
    "branch": ("train", ("arrows-split", "arrows-join", "git-branch", "git-merge", "git-fork")),
    "curved-arrow": ("val", ("arrow-loop-right", "arrow-curve-right")),
    "zigzag-arrow": ("train", ("arrow-zig-zag",)),
    "bidirectional-arrow": ("train", ("arrows-left-right",)),
    "line-chart": ("train", ("chart-line", "activity")),
    "circular-chart": ("test", ("chart-arcs", "chart-circles")),
    "dot-chart": ("val", ("chart-dots", "chart-grid-dots")),
    "route": ("test", ("route",)),
    "mixed-shapes": ("test", ("triangle-square-circle",)),
    "spiral": ("test", ("spiral",)),
    "bezier-controls": ("val", ("vector-bezier",)),
}


def source_assignment(filename: str) -> tuple[str, str]:
    """返回选定 SVG 的来源族和划分；清单外文件抛出 ValueError。"""
    for family, (split, names) in SOURCE_FAMILIES.items():
        if filename in (f"{name}.svg" for name in names):
            return family, split
    raise ValueError(f"未分配来源族：{filename}")


def _download(relative: str, staging: Path) -> dict[str, object]:
    url = f"{BASE_URL}/{relative}"
    error = ""
    for _ in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Noemori-geometry-dataset/1.0"})
            with urllib.request.urlopen(request, timeout=35) as response:
                content = response.read(2_000_001)
            if not content or len(content) > 2_000_000:
                raise ValueError("素材为空或超过下载上限")
            destination = staging / Path(relative).name
            destination.write_bytes(content)
            return {"file": destination.name, "url": url, "sha256": hashlib.sha256(content).hexdigest(),
                    "bytes": len(content), "status": "downloaded"}
        except (OSError, urllib.error.URLError, ValueError) as problem:
            error = f"{type(problem).__name__}: {problem}"
    return {"file": Path(relative).name, "url": url, "status": "failed", "reason": error}


def acquire_sources(catalog: Path, destination: Path) -> dict[str, object]:
    """下载清单中的固定版本素材和 LICENSE，原子保存报告；非空目标或清单不符时报错。"""
    document = json.loads(catalog.read_text(encoding="utf-8"))
    source = next(item for item in document["sources"] if item["id"] == "tabler-outline")
    if source["revision"] != REVISION:
        raise ValueError("catalog 与扩展生成器固定版本不同")
    filenames = source["selected_files"]
    expected = {f"{name}.svg" for _, names in SOURCE_FAMILIES.values() for name in names}
    if set(filenames) != expected or len(filenames) != len(expected):
        raise ValueError("catalog 选定素材与来源族清单不符")
    if destination.is_symlink() or (destination.exists() and
                                   (not destination.is_dir() or any(destination.iterdir()))):
        raise ValueError("拒绝覆盖已有源素材目录")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".tabler-acquire-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "sources"
        staging.mkdir()
        paths = ["LICENSE", *[f"icons/outline/{name}" for name in filenames]]
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(lambda path: _download(path, staging), paths))
        manifest = {"schema_version": 1, "source": "tabler-outline", "revision": REVISION,
                    "license": "MIT", "records": records,
                    "downloaded_svg_count": sum(record["status"] == "downloaded" and str(record["file"]).endswith(".svg")
                                                for record in records),
                    "failures": [record for record in records if record["status"] == "failed"]}
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(staging, destination)
    return manifest


def verify_sources(directory: Path) -> list[dict[str, object]]:
    """核对所有下载文件与许可，返回 SVG 来源记录；缺失、失败或散列变化时报 ValueError。"""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("revision") != REVISION or manifest.get("failures"):
        raise ValueError("源素材版本不符或下载未全部成功，见素材 manifest.failures")
    records = manifest["records"]
    if len(records) != 41 or {record["file"] for record in records} != {
        "LICENSE", *[f"{name}.svg" for _, names in SOURCE_FAMILIES.values() for name in names]
    }:
        raise ValueError("源素材清单不完整或重复")
    for record in records:
        path = directory / record["file"]
        data = path.read_bytes()
        if record["status"] != "downloaded" or len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError(f"源文件完整性不符：{path.name}")
    license_text = (directory / "LICENSE").read_text(encoding="utf-8")
    if "MIT License" not in license_text or "Copyright" not in license_text:
        raise ValueError("LICENSE 未包含预期许可与版权声明")
    return [record for record in records if str(record["file"]).endswith(".svg")]
