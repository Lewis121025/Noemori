import { Matrix, QrDecomposition } from "ml-matrix";
import { distance, segmentDistance, type FitPoint } from "./fitting-math";

/** 三次样条的节点与系数；周期形式在基函数层保证接缝的二阶连续。 */
export type CubicSpline = {
  knots: number[];
  controls: FitPoint[];
  periodic: boolean;
};

function knotsFor(count: number, periodic: boolean): number[] {
  return periodic
    ? Array.from({ length: count + 7 }, (_, i) => (i - 3) / count)
    : [
        0,
        0,
        0,
        0,
        ...Array.from({ length: count - 4 }, (_, i) => (i + 1) / (count - 3)),
        1,
        1,
        1,
        1,
      ];
}

/** Cox–de Boor递推同时求解析导数；端点取区间内极限，不跨闭合接缝差分。 */
function basis(
  knots: readonly number[],
  count: number,
  periodic: boolean,
  at: number,
  derivative = 0,
): number[] {
  const t = Math.max(0, Math.min(1 - Number.EPSILON, at));
  const levels: number[][] = [knots.slice(1).map((end, i) => (t >= knots[i]! && t < end ? 1 : 0))];
  for (let degree = 1; degree <= 3; degree++) {
    const prior = levels[degree - 1]!;
    levels.push(
      prior.slice(0, -1).map((_, i) => {
        const left = knots[i + degree]! - knots[i]!,
          right = knots[i + degree + 1]! - knots[i + 1]!;
        return (
          (left > 0 ? ((t - knots[i]!) / left) * prior[i]! : 0) +
          (right > 0 ? ((knots[i + degree + 1]! - t) / right) * prior[i + 1]! : 0)
        );
      }),
    );
  }
  const differentiated = (degree: number, order: number): number[] => {
    if (order === 0) return levels[degree]!;
    const prior = differentiated(degree - 1, order - 1);
    return prior.slice(0, -1).map((_, i) => {
      const left = knots[i + degree]! - knots[i]!,
        right = knots[i + degree + 1]! - knots[i + 1]!;
      return degree * ((left > 0 ? prior[i]! / left : 0) - (right > 0 ? prior[i + 1]! / right : 0));
    });
  };
  const values = differentiated(3, derivative);
  if (!periodic) return values;
  const wrapped = Array<number>(count).fill(0);
  values.forEach((value, i) => (wrapped[i % count]! += value));
  return wrapped;
}

/**
 * 计算规范样条的位置或参数导数；输入由拟合器保证有限，不抛异常。
 * @param spline 已求解的三次样条。
 * @param at 区间[0,1]中的有序参数，周期端点取同一接缝。
 * @param derivative 0为位置，1或2为解析导数。
 * @returns 二维位置或导数，开放曲线的端点严格使用固定系数。
 */
export function splinePoint(spline: CubicSpline, at: number, derivative: 0 | 1 | 2 = 0): FitPoint {
  if (derivative === 0 && !spline.periodic && (at <= 0 || at >= 1))
    return { ...(at <= 0 ? spline.controls[0]! : spline.controls.at(-1)!) };
  const { knots, controls, periodic } = spline,
    t = Math.max(0, Math.min(1 - Number.EPSILON, at));
  let span = 3;
  while (span < knots.length - 5 && t >= knots[span + 1]!) span++;
  const coefficient = (i: number, order: number): FitPoint => {
    if (order === 0) return controls[periodic ? i % controls.length : i]!;
    const first = coefficient(i, order - 1),
      second = coefficient(i + 1, order - 1),
      scale = (4 - order) / (knots[i + 4]! - knots[i + order]!);
    return { x: (second.x - first.x) * scale, y: (second.y - first.y) * scale };
  };
  const degree = 3 - derivative,
    values = Array.from({ length: degree + 1 }, (_, j) => ({
      ...coefficient(span - 3 + j, derivative),
    }));
  // de Boor只访问至多四个局部系数，停笔搜索不反复分配整条基函数矩阵。
  for (let level = 1; level <= degree; level++)
    for (let j = degree; j >= level; j--) {
      const i = span - 3 + j,
        alpha = (t - knots[i + derivative]!) / (knots[i + 4 - level]! - knots[i + derivative]!);
      values[j] = {
        x: (1 - alpha) * values[j - 1]!.x + alpha * values[j]!.x,
        y: (1 - alpha) * values[j - 1]!.y + alpha * values[j]!.y,
      };
    }
  return values[degree]!;
}

/** 二阶导数是分段一次函数；两点Gauss积分精确形成弯曲能量，不用控制点差分近似。 */
function bendingRows(knots: readonly number[], count: number, periodic: boolean): number[][] {
  const breaks = [...new Set(knots.filter((t) => t >= 0 && t <= 1))];
  return breaks.slice(1).flatMap((end, i) => {
    const start = breaks[i]!,
      half = (end - start) / 2,
      center = (start + end) / 2;
    return [-1, 1].map((sign) =>
      basis(knots, count, periodic, center + (sign * half) / Math.sqrt(3), 2).map(
        (value) => value * Math.sqrt(half),
      ),
    );
  });
}

/**
 * Huber迭代重加权求解带二阶导数惩罚的参数样条，QR同时求两个轴，不构造正规方程。
 * @param points 同一段的等弧长有限采样，开放段至少4点，周期段不包含重复终点。
 * @param parameters 每点对应的严格有序[0,1]参数。
 * @param count 控制点数，须在4与采样数之间。
 * @param periodic 是否使用周期三次基函数；开放端点通过消元精确固定。
 * @param penalty 非负平滑强度，目标为平均Huber位置误差加弯曲能量。
 * @param cutoff 正有限的径向Huber阈值，所有观测仍参与最终完整覆盖检查。
 * @returns 有限样条；非法输入、秩亏或退化系统返回null，数值库异常向上传播。
 */
export function solveSpline(
  points: readonly FitPoint[],
  parameters: readonly number[],
  count: number,
  periodic: boolean,
  penalty: number,
  cutoff: number,
): CubicSpline | null {
  if (
    !Number.isInteger(count) ||
    count < 4 ||
    count > points.length ||
    parameters.length !== points.length ||
    !Number.isFinite(penalty) ||
    penalty < 0 ||
    !Number.isFinite(cutoff) ||
    cutoff <= 0 ||
    !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ||
    !parameters.every(
      (t, i) => Number.isFinite(t) && t >= 0 && t <= 1 && (i === 0 || t > parameters[i - 1]!),
    )
  )
    return null;
  const knots = knotsFor(count, periodic),
    data = parameters.map((t) => basis(knots, count, periodic, t)),
    bending = bendingRows(knots, count, periodic),
    active = Array.from({ length: periodic ? count : count - 2 }, (_, i) => (periodic ? i : i + 1)),
    fixed = periodic ? [] : [0, count - 1];
  const controls = Array.from({ length: count }, (_, i) => ({
    ...(i === count - 1 ? points.at(-1)! : points[0]!),
  }));
  let weights = points.map(() => 1);
  for (let step = 0; step < 4; step++) {
    const rows: number[][] = [],
      targets: number[][] = [];
    const add = (row: readonly number[], target: FitPoint, weight: number) => {
      rows.push(active.map((i) => row[i]! * weight));
      targets.push([
        (target.x - fixed.reduce((sum, i) => sum + row[i]! * controls[i]!.x, 0)) * weight,
        (target.y - fixed.reduce((sum, i) => sum + row[i]! * controls[i]!.y, 0)) * weight,
      ]);
    };
    data.forEach((row, i) => add(row, points[i]!, Math.sqrt(weights[i]! / points.length)));
    if (penalty > 0) bending.forEach((row) => add(row, { x: 0, y: 0 }, Math.sqrt(penalty)));
    const decomposition = new QrDecomposition(new Matrix(rows));
    if (!decomposition.isFullRank()) return null;
    const solution = decomposition.solve(new Matrix(targets));
    active.forEach(
      (index, i) => (controls[index] = { x: solution.get(i, 0), y: solution.get(i, 1) }),
    );
    if (!controls.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    const fitted = { knots, controls, periodic };
    const updated = points.map((p, i) =>
      Math.min(1, cutoff / Math.max(cutoff, distance(p, splinePoint(fitted, parameters[i]!)))),
    );
    const change = Math.max(...updated.map((value, i) => Math.abs(value - weights[i]!)));
    weights = updated;
    if (change < 1e-3) break;
  }
  return { knots, controls, periodic };
}

/**
 * 按三次Bézier控制多边形的凸包上界细分；实际渲染点列与命中几何共用同一误差预算。
 * @param spline 有限规范曲线。
 * @param tolerance 正有限的归一化弦误差上限。
 * @returns 最多2048个有序点；无法在容量内达到精度返回null，不静默粗化轮廓。
 */
export function splineContour(spline: CubicSpline, tolerance: number): FitPoint[] | null {
  if (!Number.isFinite(tolerance) || tolerance <= 0) return null;
  const breaks = [...new Set(spline.knots.filter((t) => t >= 0 && t <= 1))];
  const result = [splinePoint(spline, 0)];
  const subdivide = (start: number, end: number, depth: number): boolean => {
    const a = splinePoint(spline, start),
      b = splinePoint(spline, end),
      da = splinePoint(spline, start, 1),
      db = splinePoint(spline, end, 1),
      span = (end - start) / 3;
    const error = Math.max(
      segmentDistance({ x: a.x + da.x * span, y: a.y + da.y * span }, a, b),
      segmentDistance({ x: b.x - db.x * span, y: b.y - db.y * span }, a, b),
    );
    if (result.length >= 2048 || (depth >= 12 && error > tolerance)) return false;
    if (error <= tolerance) {
      result.push(b);
      return true;
    }
    const middle = (start + end) / 2;
    return subdivide(start, middle, depth + 1) && subdivide(middle, end, depth + 1);
  };
  for (let i = 1; i < breaks.length; i++)
    if (!subdivide(breaks[i - 1]!, breaks[i]!, 0)) return null;
  if (spline.periodic) result[result.length - 1] = { ...result[0]! };
  return result;
}
