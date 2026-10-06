"""变化速度、变频、相关噪声与短突发；扰动有界且不裁去真实角点或完整回折。"""

from bisect import bisect_right
import math

from ..classification.schema import content_hash
from .geometry import CLOSED, VERSION, clean_path

PROTOCOL = ((24, .03, 105), (24, .05, 195), (60, .03, 75), (60, .05, 220),
            (120, .03, 130), (120, .05, 280), (240, .03, 165), (240, .05, 95))


def path_times(path: list, speed: float, phase: float) -> list:
    """沿真实路程以平滑变化速度积分时间，返回严格递增时刻；退化路径抛ValueError。"""
    if (len(path) < 2 or not math.isfinite(phase) or not math.isfinite(speed) or speed <= 0
            or any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in path)):
        raise ValueError("motion速度或路径退化")
    lengths = [math.dist(a, b) for a, b in zip(path, path[1:])]
    if min(lengths) <= 0:
        raise ValueError("motion速度或路径退化")
    total, distance, times = sum(lengths), 0., [0.]
    for length in lengths:
        fraction = (distance + length/2) / total
        velocity = speed * (1 + .45*math.sin(2*math.pi*2.25*fraction + phase))
        times.append(times[-1] + length/velocity)
        distance += length
    return times


def sample_motion(path: list, sampling_hz: int, speed: float, phase: float) -> tuple[list, list]:
    """定时采样并保留真实转向时刻；低采样率不会通过省略角点或回折改变目标拓扑。"""
    if sampling_hz not in (24, 60, 120, 240):
        raise ValueError("motion采样率非法")
    at_vertices = path_times(path, speed, phase)
    duration = at_vertices[-1]
    anchors = {0.: path[0], duration: path[-1]}
    for index in range(1, len(path)-1):
        a = [path[index][d]-path[index-1][d] for d in (0, 1)]
        b = [path[index+1][d]-path[index][d] for d in (0, 1)]
        cosine = sum(a[d]*b[d] for d in (0, 1)) / (math.hypot(*a)*math.hypot(*b))
        if cosine < math.cos(math.radians(40)):
            anchors[at_vertices[index]] = path[index]
    times = sorted({i/sampling_hz for i in range(math.floor(duration*sampling_hz)+1)} | set(anchors))
    points = []
    for time in times:
        if time in anchors:
            points.append(anchors[time].copy())
        else:
            index = min(len(path)-2, bisect_right(at_vertices, time)-1)
            fraction = (time-at_vertices[index])/(at_vertices[index+1]-at_vertices[index])
            points.append([path[index][d]+fraction*(path[index+1][d]-path[index][d]) for d in (0, 1)])
    return points, times


def bounded_noise(path: list, times: list, size: float, amplitude: float, phases: list) -> list:
    """变频4..16Hz叠加连续相关噪声和短突发，径向位移≤amplitude×size；非法参数抛ValueError。"""
    if (len(path) != len(times) or len(phases) != 16 or not times or times[-1] <= 0
            or not math.isfinite(size) or size <= 0 or amplitude not in (.03, .05)
            or times[0] != 0 or any(not math.isfinite(t) for t in times)
            or any(b <= a for a, b in zip(times, times[1:]))
            or any(not math.isfinite(p) for p in phases)
            or any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in path)):
        raise ValueError("motion有界噪声参数非法")
    result, duration = [], times[-1]
    center = duration*(.25 + .5*phases[15]/(2*math.pi))
    width = max(.035, duration*.035)
    scale = size*amplitude/math.sqrt(2)
    for (x, y), time in zip(path, times):
        # 相位为瞬时频率10+6sin(.7t+phase)的解析积分，避免把频率乘时间错误地当积分。
        wave = 2*math.pi*(10*time + 6/.7*(math.cos(phases[0])-math.cos(.7*time+phases[0])))
        burst = math.exp(-.5*((time-center)/width)**2)
        offsets = []
        for axis in (0, 1):
            i = 1 + axis*6
            correlated = (.5*math.sin(2*math.pi*.65*time+phases[i+1])
                          + .3*math.sin(2*math.pi*1.25*time+phases[i+2])
                          + .2*math.sin(2*math.pi*2.1*time+phases[i+3]))
            value = (.6*math.sin(wave+phases[i]) + .3*correlated
                     + .1*burst*math.sin(2*math.pi*16*time+phases[i+4]))
            offsets.append(scale*value)
        result.append([round(x+offsets[0], 9), round(y+offsets[1], 9)])
    return result


def _detail_path(path, parent, index):
    size = parent["parameters"]["size"]
    if parent["label"] == "other":
        return path, "none"
    if index == 4:
        start, end = round((len(path)-1)*.27), round((len(path)-1)*.33)
        return path[:end+1] + path[start:end][::-1] + path[start+1:], "local_retrace_6pct_point_span"
    if index == 5:
        vector = [path[-1][d]-path[-2][d] for d in (0, 1)]
        length = math.hypot(*vector)
        extra = [[path[-1][d] + vector[d]/length*size*.02*i/8 for d in (0, 1)] for i in range(1, 9)]
        return path + extra, "tail_2pct_size"
    if index == 6 and parent["label"] in CLOSED:
        lengths = [math.dist(a, b) for a, b in zip(path, path[1:])]
        target, distance, trimmed = sum(lengths)*.99, 0., [path[0]]
        for start, end, length in zip(path, path[1:], lengths):
            if distance+length >= target:
                fraction = (target-distance)/length
                trimmed.append([start[d]+fraction*(end[d]-start[d]) for d in (0, 1)])
                break
            trimmed.append(end)
            distance += length
        return trimmed, "gap_1pct_perimeter"
    return path, "none"


def variants(parent: dict) -> list[dict]:
    """每母图返回clean及八个预先固定视图，完整时间/规则可重建，不读取模型预测。"""
    original = clean_path(parent["parameters"])
    definition = {"kind": "clean", "sampling": "analytic_vertices", "speed_css_px_s": 150}
    clean = {"sample_id": content_hash([VERSION, parent["parent_id"], definition])[:32], "variant": definition,
             "paths": [original], "timestamps_seconds": path_times(original, 150, 0)}
    result = [clean]
    for index, (sampling, amplitude, speed) in enumerate(PROTOCOL):
        digest = content_hash([VERSION, "motion-field", parent["parent_id"], index])
        phases = [int(digest[i*4:(i+1)*4], 16)/65536*2*math.pi for i in range(16)]
        source, detail = _detail_path(original, parent, index)
        base, times = sample_motion(source, sampling, speed, phases[14])
        definition = {"kind": "variable_motion", "sampling_hz": sampling, "amplitude_relative_size": amplitude,
                      "speed_css_px_s": speed, "speed_factor_range": [.55, 1.45], "speed_cycles_per_path": 2.25,
                      "frequency_hz_range": [4, 16], "frequency_modulation_radians_s": .7, "phases": phases,
                      "noise": "0.6_chirp_0.3_continuous_correlated_0.1_gaussian_window_burst", "detail": detail,
                      "additional_corner_samples": True, "max_displacement_is_bounded": True}
        identifier = content_hash([VERSION, parent["parent_id"], definition])[:32]
        result.append({"sample_id": identifier, "variant": definition, "timestamps_seconds": times,
                       "paths": [bounded_noise(base, times, parent["parameters"]["size"], amplitude, phases)]})
    return result
