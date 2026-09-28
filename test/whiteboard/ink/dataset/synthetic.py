#!/usr/bin/env python3
"""生成独立真值语料：9,600 条运动轨迹和 2,400 条几何笔迹。

运行 python3 test/whiteboard/ink/dataset/synthetic.py。每个基础场景的采样率、噪声变体
留在同一集合，不能把增强变体当成独立样本。未来位置标签由连续解析轨迹计算，
不由待测预测器产生，也不把插值位置冒充真实硬件观测。输出存在时拒绝覆盖。
"""
import argparse
import gzip
import json
import math
from pathlib import Path
import random
import tempfile
from collections import Counter

from prepare import ROOT, canonical, digest, split_for, write_gzip

FAMILIES = ("constant", "acceleration", "stop", "circle", "wave", "corner", "reversal", "pause")
RATES = (60, 120, 240, 500)
NOISE = (0.0, 0.2, 1.0)
HORIZONS = (4.0, 8.0, 16.0, 24.0)
DURATION = 400.0


def transform(x, y, angle, center):
    """将解析局部轨迹旋转、平移到世界坐标，真值与观测使用同一变换。"""
    c, s = math.cos(angle), math.sin(angle)
    return [center[0] + x*c - y*s, center[1] + x*s + y*c]


def motion_position(family, t, speed):
    """返回连续轨迹真值；停止、折角和反向发生在明确时间，而非随机噪声阈值。"""
    if family == "constant":
        return speed*t, 0.0
    if family == "acceleration":
        return speed*t*t/(2*DURATION), 0.0
    if family == "stop":
        stop = DURATION*.6
        s = min(t, stop)
        return speed*(s-s*s/(2*stop)), 0.0
    if family == "circle":
        radius = speed*DURATION/(1.5*math.pi)
        angle = t*1.5*math.pi/DURATION
        return radius*math.cos(angle), radius*math.sin(angle)
    if family == "wave":
        return speed*t, speed*DURATION*.1*math.sin(t*2*math.pi/DURATION)
    if family == "corner":
        return speed*min(t, DURATION/2), speed*max(0.0, t-DURATION/2)
    if family == "reversal":
        return speed*(t if t <= DURATION/2 else DURATION-t), 0.0
    if family == "pause":
        distance = t if t <= DURATION/3 else DURATION/3 if t <= DURATION*2/3 else t-DURATION/3
        return speed*distance, 0.0
    raise ValueError("未知运动族：" + family)


def motion_parameters(group):
    """从固定场景标识恢复解析参数，供原始案例和密集恢复评测共享同一真值。"""
    rng = random.Random(group)
    speed, angle = rng.uniform(.15, 1.0), rng.uniform(-math.pi, math.pi)
    center = [rng.uniform(-1000, 1000), rng.uniform(-1000, 1000)]
    return speed, angle, center


def motions():
    """800 个基础运动场景各生成 12 个观测变体，返回固定预测时距的解析未来标签。"""
    for family in FAMILIES:
        for seed in range(100):
            group = f"motion/{family}/{seed}"
            speed, angle, center = motion_parameters(group)
            for rate in RATES:
                for noise in NOISE:
                    identifier = f"{group}/{rate}/{noise}"
                    rng = random.Random(identifier)
                    samples, queries = [], []
                    count = round(DURATION*rate/1000)
                    anchors = {round(count*f) for f in (.05, .15, .3, .45, .5, .6, .7, .9)}
                    for i in range(count+1):
                        t = i*1000/rate
                        position = transform(*motion_position(family, t, speed), angle, center)
                        samples.append([position[0]+rng.uniform(-noise, noise),
                                        position[1]+rng.uniform(-noise, noise), t])
                        if i in anchors:
                            for horizon in HORIZONS:
                                if t+horizon <= DURATION:
                                    truth = transform(*motion_position(family, t+horizon, speed), angle, center)
                                    queries.append([i, horizon, *truth])
                    yield {"id": identifier, "group": group, "kind": "motion", "family": family,
                           "rate_hz": rate, "noise_bound": noise, "samples": samples,
                           "queries": queries}


def geometries():
    """800 个基础几何场景各生成三个噪声变体，圆弧包含信息不足的 2°、5° 情况。"""
    for family in ("line", "circle", "arc", "rectangle"):
        for seed in range(200):
            group = f"geometry/{family}/{seed}"
            rng = random.Random(group)
            angle, size = rng.uniform(-math.pi, math.pi), rng.uniform(10, 200)
            center = [rng.uniform(-1000, 1000), rng.uniform(-1000, 1000)]
            width, height = size*2, size*rng.uniform(.2, 1.8)
            degrees = (2, 5, 10, 30, 90, 180)[seed % 6] if family == "arc" else 360
            clean = []
            for i in range(129):
                u = i/128
                if family == "line":
                    x, y = size*(2*u-1), 0.0
                elif family in ("circle", "arc"):
                    a = (u-.5)*math.radians(degrees)
                    x, y = size*math.cos(a), size*math.sin(a)
                else:
                    side, t = min(i//32, 3), (i % 32)/32 if i < 128 else 1.0
                    x, y = ((-width/2+width*t, -height/2), (width/2, -height/2+height*t),
                            (width/2-width*t, height/2), (-width/2, height/2-height*t))[side]
                clean.append(transform(x, y, angle, center))
            truth = {"shape": "circle" if family == "arc" else family, "center": center,
                     "radius": size, "width": width, "height": height, "angle": angle,
                     "arc_degrees": degrees, "line_start": clean[0], "line_end": clean[-1]}
            for noise in NOISE:
                identifier = f"{group}/{noise}"
                rng = random.Random(identifier)
                points = [[x+rng.uniform(-noise, noise), y+rng.uniform(-noise, noise)] for x, y in clean]
                yield {"id": identifier, "group": group, "kind": "geometry", "family": family,
                       "noise_bound": noise, "points": points, "truth": truth}


def build(output):
    """按基础场景分组发布压缩数据及校验清单；变体不会跨集合，生成失败不留下半成品。"""
    if output.exists():
        raise ValueError("输出已存在，请使用新的 --output 进行复现")
    splits = {name: [] for name in ("development", "validation", "holdout")}
    for record in motions():
        splits[split_for(digest(record["group"].encode()))].append(record)
    for record in geometries():
        splits[split_for(digest(record["group"].encode()))].append(record)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ink-synthetic-", dir=output.parent) as temporary:
        stage = Path(temporary)/"data"
        stage.mkdir()
        manifest = {"schema_version": 1, "source": "Analytic trajectories generated by dataset/synthetic.py",
                    "split_unit": "base scenario; all rate and noise variants stay together",
                    "noise_distribution": "independent uniform coordinate noise",
                    "rates_hz": RATES, "horizons_ms": HORIZONS, "splits": {}}
        for split, records in splits.items():
            path = stage/(split+".ndjson.gz")
            write_gzip(path, records)
            manifest["splits"][split] = {"file": path.name, "sha256": digest(path.read_bytes()),
                "cases": len(records), "base_scenarios": len({r["group"] for r in records}),
                "motion_cases": sum(r["kind"] == "motion" for r in records),
                "geometry_cases": sum(r["kind"] == "geometry" for r in records),
                "points": sum(len(r.get("samples", r.get("points", []))) for r in records),
                "queries": sum(len(r.get("queries", [])) for r in records)}
        (stage/"manifest.json").write_bytes(canonical(manifest)+b"\n")
        verify(stage)
        stage.rename(output)
    print(canonical(manifest).decode())


def verify(output):
    """校验文件、独立场景归属、真值索引及变体完整性，不对保留集运行算法评分。"""
    manifest = json.loads((output/"manifest.json").read_text())
    groups, identifiers, variants, truths = {}, set(), Counter(), {}
    for split, entry in manifest["splits"].items():
        filename = split+".ndjson.gz"
        path = output/filename
        if entry["file"] != filename or digest(path.read_bytes()) != entry["sha256"]:
            raise ValueError("合成文件名或校验和错误")
        with gzip.open(path, "rt", encoding="utf-8") as source:
            records = [json.loads(line) for line in source]
        for record in records:
            group = record["group"]
            if record["id"] in identifiers or groups.get(group, split) != split:
                raise ValueError("重复案例或基础场景跨集合")
            if split_for(digest(group.encode())) != split:
                raise ValueError("场景分组不匹配")
            groups[group] = split
            identifiers.add(record["id"])
            variants[group] += 1
            if record["kind"] == "motion":
                samples = record["samples"]
                if any(b[2] <= a[2] for a, b in zip(samples, samples[1:])):
                    raise ValueError("合成轨迹时间不递增")
                for index, horizon, x, y in record["queries"]:
                    if index < 0 or index >= len(samples) or horizon not in HORIZONS:
                        raise ValueError("真值索引或时距错误")
                    if samples[index][2]+horizon > DURATION or not all(math.isfinite(v) for v in (x,y)):
                        raise ValueError("真值时间越界或坐标非有限")
                key = (group, record["rate_hz"])
                value = digest(canonical(record["queries"]))
                if truths.get(key, value) != value:
                    raise ValueError("噪声变体改变了解析真值")
                truths[key] = value
        observed = {"cases": len(records), "base_scenarios": len({r["group"] for r in records}),
                    "motion_cases": sum(r["kind"] == "motion" for r in records),
                    "geometry_cases": sum(r["kind"] == "geometry" for r in records),
                    "points": sum(len(r.get("samples", r.get("points", []))) for r in records),
                    "queries": sum(len(r.get("queries", [])) for r in records)}
        if any(entry[key] != value for key, value in observed.items()):
            raise ValueError("合成清单统计与实际数据不一致")
    if len(groups) != 1600 or len(identifiers) != 12000:
        raise ValueError("独立场景或变体总量不完整")
    for group, count in variants.items():
        if count != (12 if group.startswith("motion/") else 3):
            raise ValueError("场景缺少观测变体")
    print("合成语料校验通过：",len(groups),"个基础场景，",len(identifiers),"条案例",flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT/"fixtures"/"synthetic-v1")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    verify(args.output) if args.verify else build(args.output)
