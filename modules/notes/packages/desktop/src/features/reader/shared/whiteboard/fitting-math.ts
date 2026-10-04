/** 拟合内部使用的无量纲坐标；先平移并缩放，避免大世界坐标破坏数值条件。 */
export type FitPoint = { x: number; y: number };

/** 计算两点欧氏距离，输入必须已校验为有限坐标。 */
export function distance(a: FitPoint, b: FitPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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

/** Ramer–Douglas–Peucker 简化开放轮廓；闭合轮廓由调用方拆为两段后合并。 */
export function simplify(points: readonly FitPoint[], tolerance: number): FitPoint[] {
  if (points.length < 3) return [...points];
  let maximum = tolerance,
    split = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const deviation = segmentDistance(points[i]!, points[0]!, points.at(-1)!);
    if (deviation > maximum) {
      maximum = deviation;
      split = i;
    }
  }
  return split < 0
    ? [points[0]!, points.at(-1)!]
    : [
        ...simplify(points.slice(0, split + 1), tolerance).slice(0, -1),
        ...simplify(points.slice(split), tolerance),
      ];
}

/** 拟合与原始路径双向比较，避免残缺圆、U 形轮廓被补全成完整图形。 */
export function fitAgrees(source: readonly FitPoint[], fitted: readonly FitPoint[]): boolean {
  if (fitted.length < 2) return false;
  const directed = (from: readonly FitPoint[], to: readonly FitPoint[]) =>
    resample(from, 192).map((point) => {
      let best = Infinity;
      for (let i = 1; i < to.length; i++)
        best = Math.min(best, segmentDistance(point, to[i - 1]!, to[i]!));
      return best;
    });
  const deviations = [...directed(source, fitted), ...directed(fitted, source)];
  return (
    deviations.length > 0 &&
    Math.max(...deviations) <= 0.075 &&
    Math.sqrt(deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length) <= 0.028
  );
}
