"""保留真实行程、角点和回折的定时观测，叠加径向有界的时间相关抖动。"""

from bisect import bisect_right
import math

from ..classification.schema import content_hash
from ..detail.geometry import clean_path

VERSION = "shape-tremor-invariance-v1"
PROTOCOL = ((60, 60, 6, .015), (120, 180, 9, .015), (240, 420, 12, .03),
            (60, 420, 9, .03), (120, 60, 12, .05), (240, 180, 6, .05))


def timed_path(path: list, sampling_hz: int, speed: float) -> tuple[list, list]:
    """按真实路径长度定时采样并额外保留角点时刻；不消除完整折返，非法参数抛ValueError。"""
    if (sampling_hz not in (60, 120, 240) or not math.isfinite(speed) or speed <= 0
            or len(path) < 2 or any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in path)):
        raise ValueError("定时路径、采样率或速度非法")
    distances = [0.]
    for start, end in zip(path, path[1:]):
        length = math.dist(start, end)
        if length <= 0:
            raise ValueError("母图包含退化相邻点")
        distances.append(distances[-1] + length)
    duration = distances[-1] / speed
    regular = [i / sampling_hz for i in range(math.floor(duration * sampling_hz) + 1)]
    anchors = {0.: path[0], duration: path[-1]}
    for index in range(1, len(path)-1):
        a = [path[index][d] - path[index-1][d] for d in (0, 1)]
        b = [path[index+1][d] - path[index][d] for d in (0, 1)]
        cosine = sum(a[d]*b[d] for d in (0, 1)) / (math.hypot(*a)*math.hypot(*b))
        if cosine < math.cos(math.radians(40)):
            anchors[distances[index] / speed] = path[index]
    times = sorted(set(regular) | set(anchors))
    points = []
    for time in times:
        if time in anchors:
            points.append(anchors[time].copy())
            continue
        distance = time * speed
        index = min(len(path)-2, bisect_right(distances, distance)-1)
        fraction = (distance-distances[index]) / (distances[index+1]-distances[index])
        points.append([path[index][d] + fraction*(path[index+1][d]-path[index][d]) for d in (0, 1)])
    return points, times


def temporal_jitter(path: list, times: list, size: float, amplitude: float, frequency: float, phases: list) -> list:
    """以真实时间的基频/二次谐波扰动，径向位移≤amplitude×size；同坐标回访可有不同偏移。"""
    if (len(path) != len(times) or len(phases) != 4 or not all(math.isfinite(v) for v in phases)
            or not math.isfinite(size) or size <= 0 or amplitude not in (.015, .03, .05)
            or frequency not in (6, 9, 12) or any(not math.isfinite(t) or t < 0 for t in times)):
        raise ValueError("时间抖动参数非法")
    scale = size * amplitude / math.sqrt(2)
    result = []
    for (x, y), time in zip(path, times):
        phase = 2 * math.pi * frequency * time
        dx = .8 * math.sin(phase + phases[0]) + .2 * math.sin(2*phase + phases[1])
        dy = .8 * math.sin(phase + phases[2]) + .2 * math.sin(2*phase + phases[3])
        result.append([round(x + scale*dx, 9), round(y + scale*dy, 9)])
    return result


def variants(parent: dict) -> list[dict]:
    """每个原母图固定六个可重建视图；组合/相位与模型预测和测试结果无关。"""
    original, result = clean_path(parent["parameters"]), []
    for index, (sampling, speed, frequency, amplitude) in enumerate(PROTOCOL):
        digest = content_hash([VERSION, parent["parent_id"], "phases", index])
        phases = [int(digest[i*8:(i+1)*8], 16) / 2**32 * 2*math.pi for i in range(4)]
        base, times = timed_path(original, sampling, speed)
        definition = {"kind": "temporal_tremor", "sampling_hz": sampling, "speed_css_px_s": speed,
                      "frequency_hz": frequency, "amplitude_relative_size": amplitude, "phases": phases,
                      "field": "time_sines_0.8_f_0.2_2f", "additional_corner_samples": True,
                      "max_displacement_is_bounded": True}
        identifier = content_hash([VERSION, parent["parent_id"], definition])[:32]
        result.append({"sample_id": identifier, "variant": definition, "timestamps_seconds": times,
                       "paths": [temporal_jitter(base, times, parent["parameters"]["size"], amplitude, frequency, phases)]})
    return result
