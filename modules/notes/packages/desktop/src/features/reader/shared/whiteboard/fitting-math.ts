/** 拟合内部使用的无量纲坐标；先平移并缩放，避免大世界坐标破坏数值条件。 */
export type FitPoint = { x: number; y: number };

/** 计算两点欧氏距离，输入必须已校验为有限坐标。 */
export function distance(a: FitPoint, b: FitPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 投影后的反向推进最多占净推进的八分之一；允许局部回描，拒绝大范围往返。
 * 横向抖动不计入该预算，调用方仍须验证完整覆盖和原始轮廓误差。
 * @param deltas 已归一化轨迹在拟合轴或圆周参数上的有向增量。
 * @returns 满足回描预算的净推进量；零推进、非有限值或超预算返回 null，不抛异常。
 */
export function traceAdvance(deltas: readonly number[]): number | null {
  const advance = deltas.reduce((sum, value) => sum + value, 0);
  const travel = deltas.reduce((sum, value) => sum + Math.abs(value), 0);
  const reversed = (travel - Math.abs(advance)) / 2;
  return Math.abs(advance) > 1e-8 && reversed <= Math.abs(advance) / 8 + 1e-8 ? advance : null;
}

/**
 * 圆周参数的有向净推进；每段取连续短弧，重复整圈由调用方的覆盖范围约束拒绝。
 * @param angles 按轮廓顺序排列的弧度，调用方须先保证采样间隔小于半圈。
 * @returns 满足局部回描预算的有向扫角；非法或超预算返回 null，不抛异常。
 */
export function angleAdvance(angles: readonly number[]): number | null {
  return traceAdvance(
    angles.slice(1).map((angle, i) => {
      const delta = angle - angles[i]!;
      return Math.atan2(Math.sin(delta), Math.cos(delta));
    }),
  );
}

/**
 * 单调链构造已选多边形拟合族的边界候选，不改变分类输入或原始笔迹。
 * @param points 已校验的有限归一化点；允许回描造成的重复访问。
 * @returns 去重后的凸边界顶点；退化点集返回至多两个点，不抛异常。
 */
export function contourHull(points: readonly FitPoint[]): FitPoint[] {
  const sorted = [...points]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, i, all) => i === 0 || point.x !== all[i - 1]!.x || point.y !== all[i - 1]!.y);
  if (sorted.length < 3) return sorted;
  const cross = (a: FitPoint, b: FitPoint, c: FitPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (values: readonly FitPoint[]) => {
    const hull: FitPoint[] = [];
    for (const point of values) {
      while (hull.length > 1 && cross(hull.at(-2)!, hull.at(-1)!, point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * 把闭合多边形轨迹投影到候选周长，回描预算按实际边长计算，不受重复顶点影响。
 * @param source 按采样顺序的原始点列，相邻采样不得跨越半个候选周长。
 * @param fitted 首尾相同的闭合拟合候选；完整覆盖与偏差仍须由调用方校验。
 * @returns 满足局部回描预算的有向周数；退化候选或过量折返返回 null，不抛异常。
 */
export function perimeterAdvance(
  source: readonly FitPoint[],
  fitted: readonly FitPoint[],
): number | null {
  const lengths = fitted.slice(1).map((point, i) => distance(point, fitted[i]!));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const along = source.map((point) => {
    let offset = 0,
      position = 0,
      best = Infinity;
    for (let i = 1; i < fitted.length; i++) {
      const a = fitted[i - 1]!,
        b = fitted[i]!,
        length = lengths[i - 1]!;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const t =
        length === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)),
            );
      const error = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
      if (error < best) {
        best = error;
        position = offset + t * length;
      }
      offset += length;
    }
    return position / total;
  });
  return traceAdvance(
    along.slice(1).map((position, i) => {
      const delta = position - along[i]!;
      return delta - Math.round(delta);
    }),
  );
}

/** 点到有限线段距离；零长度线段按端点处理。 */
export function segmentDistance(p: FitPoint, a: FitPoint, b: FitPoint): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** 按弧长等距重采样，消除停顿时密集采样对拟合权重的影响；退化路径返回空数组。 */
export function resample(points: readonly FitPoint[], count: number): FitPoint[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(lengths.at(-1)! + distance(points[i - 1]!, points[i]!));
  const total = lengths.at(-1)!;
  if (!(total > 0)) return [];
  let segment = 1;
  return Array.from({ length: count }, (_, i) => {
    const target = (total * i) / (count - 1);
    while (segment < points.length - 1 && lengths[segment]! < target) segment++;
    const a = points[segment - 1]!,
      b = points[segment]!;
    const span = lengths[segment]! - lengths[segment - 1]!;
    const t = span === 0 ? 0 : (target - lengths[segment - 1]!) / span;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}

/** 最小二乘解小型线性系统；奇异或严重病态时返回 null，禁止输出失控参数。 */
export function leastSquares(
  rows: readonly number[][],
  targets: readonly number[],
): number[] | null {
  const size = rows[0]!.length;
  const matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size + 1 }, (_, j) =>
      rows.reduce((sum, row, k) => sum + row[i]! * (j === size ? targets[k]! : row[j]!), 0),
    ),
  );
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++)
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    if (Math.abs(matrix[pivot]![column]!) < 1e-8) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const divisor = matrix[column]![column]!;
    for (let j = column; j <= size; j++) matrix[column]![j]! /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      for (let j = column; j <= size; j++) matrix[row]![j]! -= factor * matrix[column]![j]!;
    }
  }
  const result = matrix.map((row) => row[size]!);
  return result.every(Number.isFinite) ? result : null;
}

/** 用正交最小二乘拟合无限直线；零方差点集无方向，返回 null。 */
export function principalLine(
  points: readonly FitPoint[],
): { center: FitPoint; angle: number } | null {
  const center = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  let xx = 0,
    xy = 0,
    yy = 0;
  for (const p of points) {
    const x = p.x - center.x,
      y = p.y - center.y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  return xx + yy < 1e-10 ? null : { center, angle: Math.atan2(2 * xy, xx - yy) / 2 };
}

const MAX_CONTOUR_DEVIATION = 0.075;

function contourDistance(point: FitPoint, contour: readonly FitPoint[]): number {
  let best = Infinity;
  for (let i = 1; i < contour.length; i++)
    best = Math.min(best, segmentDistance(point, contour[i - 1]!, contour[i]!));
  return best;
}

/**
 * 原始位置观测逐点检查最大误差，不把停笔时的微抖来回按几何弧长重复加权。
 * @param source 全部原始观测，使用静态轨迹的同一中心和尺寸归一化。
 * @param fitted 已通过完整覆盖与 RMS 检查的候选轮廓。
 * @returns 所有观测都在既有最大偏差内时为 true；非法坐标或退化轮廓返回 false。
 */
export function observationsAgree(
  source: readonly FitPoint[],
  fitted: readonly FitPoint[],
): boolean {
  return (
    source.length > 0 &&
    source.every((point) => contourDistance(point, fitted) <= MAX_CONTOUR_DEVIATION)
  );
}

/** 拟合与静态几何轨迹双向比较，避免残缺圆、U 形轮廓被补全成完整图形。 */
export function fitAgrees(source: readonly FitPoint[], fitted: readonly FitPoint[]): boolean {
  if (fitted.length < 2) return false;
  const directed = (from: readonly FitPoint[], to: readonly FitPoint[]) =>
    resample(from, 192).map((point) => contourDistance(point, to));
  const deviations = [...directed(source, fitted), ...directed(fitted, source)];
  return (
    deviations.length > 0 &&
    Math.max(...deviations) <= MAX_CONTOUR_DEVIATION &&
    Math.sqrt(deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length) <= 0.028
  );
}
