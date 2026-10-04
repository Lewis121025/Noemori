"""独立 CPU 进程测量 ONNX 推理，避免把训练进程的 CUDA/PyTorch 内存计入部署。"""

import argparse
import json
from pathlib import Path
import platform
import resource
import time

import numpy as np
import onnxruntime as ort
from PIL import Image


def image_tensor(path: Path, preprocessing: dict) -> np.ndarray:
    """按导出契约生成连续 FP32 NCHW 张量；拒绝未规范化尺寸与模式的图片。"""
    with Image.open(path) as image:
        if image.mode != "RGB" or image.size != (224, 224):
            raise ValueError("要求 224×224 RGB 输入")
        pixels = np.array(image, dtype=np.float32) / np.float32(255)
    mean = np.array(preprocessing["mean"], dtype=np.float32)
    std = np.array(preprocessing["std"], dtype=np.float32)
    return np.ascontiguousarray(((pixels - mean) / std).transpose(2, 0, 1)[None])


def _rss_bytes() -> int:
    with Path("/proc/self/status").open() as handle:
        for line in handle:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    raise RuntimeError("当前内存测量要求 Linux /proc")


def _distribution(samples: list[float]) -> dict:
    return {"count": len(samples), "p50_ms": float(np.percentile(samples, 50)),
            "p95_ms": float(np.percentile(samples, 95)), "p99_ms": float(np.percentile(samples, 99))}


def benchmark(bundle: Path, dataset: Path, iterations: int = 200, threads: int = 4) -> dict:
    """测量热推理和含 PNG 解码的流水线；不代表用户设备、SVG 栅格化或 GUI 延迟。"""
    if iterations < 20 or threads < 1:
        raise ValueError("至少20次采样，推理线程数必须为正")
    manifest = json.loads((bundle / "manifest.json").read_text())
    rows = [json.loads(line) for line in (dataset / "val.jsonl").read_text().splitlines()]
    if not rows:
        raise ValueError("缺少延迟测试输入")
    rows = rows[::max(1, len(rows) // 32)][:32]
    paths = [dataset / row["image"] for row in rows]
    tensors = [image_tensor(path, manifest["preprocessing"]) for path in paths]
    baseline_rss = _rss_bytes()
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    started = time.perf_counter()
    session = ort.InferenceSession(str(bundle / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    session.run(None, {"images": tensors[0]})
    first_ms = (time.perf_counter() - started) * 1000
    for i in range(20):
        session.run(None, {"images": tensors[i % len(tensors)]})
    kernel, pipeline = [], []
    for i in range(iterations):
        index = i % len(tensors)
        started = time.perf_counter()
        session.run(None, {"images": tensors[index]})
        kernel.append((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        tensor = image_tensor(paths[index], manifest["preprocessing"])
        session.run(None, {"images": tensor})
        pipeline.append((time.perf_counter() - started) * 1000)
    cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), platform.processor())
    return {"scope": "local_server_cpu_benchmark", "cpu": cpu, "platform": platform.platform(),
            "onnxruntime": ort.__version__, "provider": session.get_providers(), "threads": threads,
            "batch": 1, "session_load_ms": load_ms, "first_inference_ms": first_ms,
            "warm_inference": _distribution(kernel), "png_preprocess_inference": _distribution(pipeline),
            "baseline_rss_bytes": baseline_rss, "loaded_rss_bytes": _rss_bytes(),
            "rss_increment_bytes": _rss_bytes() - baseline_rss,
            "process_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "limitations": ["Xeon服务器实测，不是普通用户电脑或最低配置验收。",
                            "包含PNG读取与归一化，不含笔迹分组、SVG栅格化、IPC、几何拟合和UI绘制。",
                            "模型与图片可能已在文件系统缓存；不能作为冷磁盘首次启动耗时。"]}


def main() -> None:
    """独立运行 CPU 测量并输出 JSON，不加载训练框架。"""
    parser = argparse.ArgumentParser(description="ONNX CPU 性能测量")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("拒绝覆盖已有性能报告")
    result = benchmark(args.bundle, args.dataset, threads=args.threads)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
