import { distance, type FitPoint } from "./fitting-math";
import { stabilizeTrace } from "./stabilization";

/** 交叉的访问身份与方向；只比较空间交叉数无法防止换环或交换绘制顺序。 */
type Crossing = { point: FitPoint; first: number; second: number; orientation: number };
/** 自由曲线的有序交叉证据，微抖拓扑只在统一位置分辨率下评估。 */
export type CurveStructure = { crossings: Crossing[]; visits: number[] };

const cross = (a: FitPoint, b: FitPoint) => a.x * b.y - a.y * b.x;
const subtract = (a: FitPoint, b: FitPoint) => ({ x: a.x - b.x, y: a.y - b.y });

/** 统计同一轨迹边段上的重复访问长度；邻接接头不计重描，近似平行的回访合并区间。 */
function repeatedLength(points: readonly FitPoint[], tolerance: number): number {
  let repeated = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      direction = subtract(b, a),
      length = distance(a, b);
    if (length < tolerance * 4) continue;
    const intervals: [number, number][] = [];
    for (let j = 1; j < i; j++) {
      const c = points[j - 1]!,
        d = points[j]!,
        other = subtract(d, c),
        span = distance(c, d);
      if (span < tolerance * 4 || Math.abs(cross(direction, other)) > length * span * 0.18)
        continue;
      if (
        Math.abs(cross(direction, subtract(c, a))) / length > tolerance ||
        Math.abs(cross(direction, subtract(d, a))) / length > tolerance
      )
        continue;
      const along = (p: FitPoint) =>
        ((p.x - a.x) * direction.x + (p.y - a.y) * direction.y) / length;
      const start = Math.max(0, Math.min(along(c), along(d))),
        end = Math.min(length, Math.max(along(c), along(d)));
      if (end > start) intervals.push([start, end]);
    }
    let covered = 0;
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
      repeated += Math.max(0, end - Math.max(covered, start));
      covered = Math.max(covered, end);
    }
  }
  return repeated;
}

/**
 * 从顺序轮廓提取宏观交叉与回访证据，防止自由样条绕过规则图形的重描拒绝契约。
 * @param points 有限归一化轮廓，调用方先校验输入与点数。
 * @param tolerance 与实际渲染共用的位置分辨率，须为正有限数。
 * @param noiseAllowance 可消除的局部打结半径；零表示保留所有可分辨交叉，不放宽重描预算。
 * @returns 有序交叉结构；过量重描、退化轮廓或超出16个交叉返回null，不抛异常。
 */
export function curveStructure(
  points: readonly FitPoint[],
  tolerance: number,
  noiseAllowance = 0,
): CurveStructure | null {
  if (
    points.length < 2 ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    !Number.isFinite(noiseAllowance) ||
    noiseAllowance < 0
  )
    return null;
  const trace = stabilizeTrace(points, tolerance),
    traversal = stabilizeTrace(points, Math.max(tolerance, 0.006)),
    total = traversal.slice(1).reduce((sum, p, i) => sum + distance(traversal[i]!, p), 0);
  if (
    trace.length < 4 ||
    total < 0.1 ||
    repeatedLength(traversal, Math.max(tolerance, 0.012)) > total / 9
  )
    return null;
  const crossings: Crossing[] = [];
  const closed = distance(trace[0]!, trace.at(-1)!) < tolerance;
  for (let i = 1; i < trace.length; i++)
    for (let j = i + 2; j < trace.length; j++) {
      if (closed && i === 1 && j === trace.length - 1) continue;
      const a = trace[i - 1]!,
        c = trace[j - 1]!,
        first = subtract(trace[i]!, a),
        second = subtract(trace[j]!, c),
        denominator = cross(first, second);
      if (Math.abs(denominator) < 1e-10) continue;
      const delta = subtract(c, a),
        t = cross(delta, second) / denominator,
        u = cross(delta, first) / denominator;
      if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
      const point = { x: a.x + t * first.x, y: a.y + t * first.y };
      // 噪声尺度内的局部打结可作为抖动消除；宏观环仍保持同一交叉身份。
      if (
        noiseAllowance > 0 &&
        trace.slice(i, j).every((p) => distance(p, point) <= noiseAllowance)
      )
        continue;
      crossings.push({
        point,
        first: i - 1 + t,
        second: j - 1 + u,
        orientation: Math.sign(denominator),
      });
      if (crossings.length > 16) return null;
    }
  crossings.sort((a, b) => a.first - b.first);
  const visits = crossings
    .flatMap((entry, id) => [
      { at: entry.first, id },
      { at: entry.second, id },
    ])
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.id);
  return { crossings, visits };
}

/**
 * 验证拟合保留交叉位置、方向和两次访问顺序，交叉数相同也不能交换环的连接关系。
 * @param source 去抖分辨率下的原始结构。
 * @param fitted 同一分辨率下的实际渲染结构。
 * @returns 每个对应交叉偏移不超过3%轮廓尺寸且访问一致时为true；拒绝不抛异常。
 */
export function curveStructureAgrees(source: CurveStructure, fitted: CurveStructure): boolean {
  return (
    source.crossings.length === fitted.crossings.length &&
    source.visits.every((id, i) => id === fitted.visits[i]) &&
    source.crossings.every(
      (entry, i) =>
        entry.orientation === fitted.crossings[i]!.orientation &&
        distance(entry.point, fitted.crossings[i]!.point) <= 0.03,
    )
  );
}
