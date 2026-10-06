"""有界、空间一致的细节变体；保持已知目标拓扑，不删除箭翼或闭合开放圆弧。"""

import math

from ..classification.schema import content_hash
from .geometry import CLOSED, clean_path


def _unit(vector):
    length = math.hypot(*vector)
    if length <= 1e-10:
        raise ValueError("变体切向量退化")
    return [coordinate/length for coordinate in vector]


def spatial_jitter(path: list, size: float, amplitude: float, phases: list[float]) -> list:
    """按空间坐标连续高频场扰动，位移不超过amplitude×size；同坐标回访偏移完全相同。"""
    result = []
    for x, y in path:
        u, v = x/size, y/size
        dx = .65*math.sin(2*math.pi*(11*u+7*v)+phases[0]) + .35*math.sin(2*math.pi*(5*u-13*v)+phases[1])
        dy = .65*math.sin(2*math.pi*(9*u-8*v)+phases[2]) + .35*math.sin(2*math.pi*(14*u+3*v)+phases[3])
        scale = amplitude*size/math.sqrt(2)
        result.append([round(x+scale*dx, 9), round(y+scale*dy, 9)])
    return result


def _retrace(path, size, start_fraction, span_fraction, offset):
    start = max(1, round((len(path)-1)*start_fraction))
    end = min(len(path)-2, start + max(4, round((len(path)-1)*span_fraction)))
    backward = []
    for index in range(end-1, start-1, -1):
        tangent = _unit([path[index+1][d]-path[index-1][d] for d in (0, 1)])
        displacement = offset*size*math.sin(math.pi*(index-start)/(end-start))
        backward.append([round(path[index][0]-tangent[1]*displacement, 9), round(path[index][1]+tangent[0]*displacement, 9)])
    return path[:end+1] + backward + path[start+1:end+1] + path[end+1:]


def _tail(path, size, length_fraction, bend):
    tangent = _unit([path[-1][d]-path[-2][d] for d in (0, 1)])
    normal = [-tangent[1], tangent[0]]
    length = length_fraction*size
    # 路程积分近似后缩放，避免标称5%尾巴实际因侧弯超过5%。
    points = [[length*(tangent[d]*t + normal[d]*bend*t*t/2) for d in (0, 1)] for t in [i/12 for i in range(13)]]
    actual = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
    extra = [[round(path[-1][d]+point[d]*length/actual, 9) for d in (0, 1)] for point in points[1:]]
    return path + extra


def _gap(path, missing_fraction):
    lengths = [math.dist(a, b) for a, b in zip(path, path[1:])]
    target = sum(lengths)*(1-missing_fraction)
    result, distance = [path[0]], 0.0
    for start, end, length in zip(path, path[1:], lengths):
        if distance + length >= target:
            fraction = (target-distance)/length
            result.append([round(start[d]+fraction*(end[d]-start[d]), 9) for d in (0, 1)])
            break
        result.append(end)
        distance += length
    return result


def variants(parent: dict) -> list[dict]:
    """返回包含clean的八/十个固定视图定义；参数可重建，同母图扰动共用确定性空间相位。"""
    size = parent["parameters"]["size"]
    path = clean_path(parent["parameters"])
    digest = content_hash(["detail-spatial-field-v1", parent["parent_id"]])
    phases = [int(digest[i*8:(i+1)*8], 16)/(2**32)*2*math.pi for i in range(4)]
    definitions = [{"kind": "clean"}]
    definitions += [{"kind": "jitter", "amplitude_relative_size": amplitude, "phases": phases,
                     "field": "spatial_sines_11_7_5_minus13_9_minus8_14_3", "max_displacement_is_bounded": True} for amplitude in (.005, .015, .03)]
    definitions += [{"kind": "retrace", "start_fraction_of_point_index": .24, "span_fraction_of_point_index": .12,
                     "offset_relative_size": offset, "traversal": "forward_backward_forward", "offset_taper": "sin_pi_window"} for offset in (0, .002)]
    definitions += [{"kind": "tail", "length_relative_size": length, "bend": .65 if int(digest[-1], 16)%2 else -.65} for length in (.02, .05)]
    if parent["label"] in CLOSED:
        definitions += [{"kind": "gap", "missing_fraction_of_perimeter": missing} for missing in (.01, .02)]
    result = []
    for definition in definitions:
        kind = definition["kind"]
        if kind == "clean":
            transformed = path
        elif kind == "jitter":
            transformed = spatial_jitter(path, size, definition["amplitude_relative_size"], phases)
        elif kind == "retrace":
            transformed = _retrace(path, size, .24, .12, definition["offset_relative_size"])
        elif kind == "tail":
            transformed = _tail(path, size, definition["length_relative_size"], definition["bend"])
        else:
            transformed = _gap(path, definition["missing_fraction_of_perimeter"])
        identifier = content_hash(["detail-view-v1", parent["parent_id"], definition])[:32]
        result.append({"sample_id": identifier, "variant": definition, "paths": [transformed]})
    return result
