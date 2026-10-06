"""保护既有评价像素与旧细节探针；仅作隔离，不参与母图生成或目标标注。"""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from PIL import Image

from ..classification.acquire import file_record
from ..classification.schema import content_hash


def pixel_hash(path: Path) -> str:
    """核验产品RGB224图并返回解码像素散列；格式或尺寸错误拒绝作为有效视图。"""
    with Image.open(path) as image:
        if image.size != (224, 224) or image.mode != "RGB":
            raise ValueError("细节图必须为224×224 RGB")
        return hashlib.sha256(image.tobytes()).hexdigest()


def render_requests(renderer: Path, requests: list[dict]) -> None:
    """通过产品可执行程序渲染全部请求；标准输入用临时文件避免大JSON驻留，失败原样抛出。"""
    with tempfile.TemporaryFile(mode="w+") as handle:
        for request in requests:
            handle.write(json.dumps(request, separators=(",", ":")) + "\n")
        handle.seek(0)
        subprocess.run([str(renderer.resolve())], stdin=handle, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)


def collect_reserved(native: Path, clean_diagnostic: Path, old_probe: Path, renderer: Path, staging: Path) -> dict:
    """收集既有val/test、独立诊断和旧探针像素，并用当前渲染器重渲染诊断；保留来源散列。"""
    native_manifest = json.loads((native / "manifest.json").read_text())
    if file_record(native / "records.jsonl") != native_manifest["records"]:
        raise ValueError("旧端侧评价记录快照不符")
    protected = set(native_manifest.get("reserved_pixel_sha256", []))
    protected_records, requests, source_snapshots = [], [], []
    with (native / "records.jsonl").open() as handle:
        for line in handle:
            row = json.loads(line)
            if row["split"] not in ("val", "test"):
                continue
            original = native / row["image"]
            if file_record(original)["sha256"] != row["image_sha256"] or pixel_hash(original) != row["pixel_sha256"]:
                raise ValueError("旧端侧val/test图像散列不符")
            digests = [row["pixel_sha256"], row["original_pixel_sha256"]]
            protected.update(digests)
            protected_records.append({"source": str(native.resolve()), "sample_id": row["sample_id"],
                                      "split": row["split"], "pixel_sha256": digests})
    source_snapshots.append({"source": str(native.resolve()), "manifest": file_record(native / "manifest.json"),
                             "records": file_record(native / "records.jsonl"), "renderer": native_manifest["renderer"]})
    (staging / "reserved-rendered").mkdir()
    old_clean_geometry = []
    for kind, directory in (("clean_diagnostic", clean_diagnostic), ("old_detail_probe", old_probe)):
        cases = directory / "cases.jsonl"
        source_snapshots.append({"source": str(directory.resolve()), "kind": kind, "cases": file_record(cases)})
        with cases.open() as handle:
            for index, line in enumerate(handle):
                row = json.loads(line)
                original = directory / row["image"]
                original_file = file_record(original)
                if row.get("image_sha256", original_file["sha256"]) != original_file["sha256"]:
                    raise ValueError("独立诊断原图散列不符")
                original_pixel = pixel_hash(original)
                protected.add(original_pixel)
                output = staging / "reserved-rendered" / f"{kind}-{index:04}.png"
                requests.append({"paths": row["paths"], "output": str(output.resolve())})
                protected_records.append({"source": str(directory.resolve()), "case_index": index,
                                          "image_file": original_file, "original_pixel_sha256": original_pixel,
                                          "rerendered_image": str(output.relative_to(staging)), "paths_sha256": content_hash(row["paths"])})
                if kind == "old_detail_probe" and row.get("detail") == "clean":
                    old_clean_geometry.append(content_hash(row["paths"]))
    render_requests(renderer, requests)
    for record in protected_records:
        if "rerendered_image" in record:
            path = staging / record["rerendered_image"]
            digest = pixel_hash(path)
            protected.add(digest)
            record.update({"rerendered_pixel_sha256": digest, "rerendered_file": file_record(path)})
    return {"pixel_sha256": sorted(protected), "source_snapshots": source_snapshots,
            "records": protected_records, "old_probe_clean_paths_sha256": sorted(set(old_clean_geometry))}
