import { distance, type FitPoint } from "./fitting-math";

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/**
 * 二次局部回归提供保形导向，仅用于参数与噪声估计。
 * @param points 至少九个有限等弧长点。
 * @param periodic 是否周期延拓。
 * @param halfWindow 半窗口，不超过可用邻点数。
 * @returns 与输入等长的导向；不替换真实观测。
 */
export function pilotContour(
  points: readonly FitPoint[],
  periodic: boolean,
  halfWindow = 4,
): FitPoint[] {
  const denominator = (2 * halfWindow + 3) * (2 * halfWindow + 1) * (2 * halfWindow - 1),
    weights = Array.from(
      { length: 2 * halfWindow + 1 },
      (_, i) =>
        (3 * (3 * halfWindow ** 2 + 3 * halfWindow - 1 - 5 * (i - halfWindow) ** 2)) / denominator,
    );
  const at = (index: number): FitPoint => {
    if (periodic) return points[(index + points.length) % points.length]!;
    if (index < 0)
      return { x: 2 * points[0]!.x - points[-index]!.x, y: 2 * points[0]!.y - points[-index]!.y };
    if (index >= points.length) {
      const mirrored = points[2 * (points.length - 1) - index]!,
        last = points.at(-1)!;
      return { x: 2 * last.x - mirrored.x, y: 2 * last.y - mirrored.y };
    }
    return points[index]!;
  };
  return points.map((_, i) =>
    weights.reduce(
      (sum, weight, j) => {
        const point = at(i + j - halfWindow);
        return { x: sum.x + weight * point.x, y: sum.y + weight * point.y };
      },
      { x: 0, y: 0 },
    ),
  );
}

/**
 * 从导向的正交残差MAD估计实测噪声，孤立尖角不扩大预算。
 * @param points 有限等弧长轮廓。
 * @param periodic 是否周期延拓。
 * @returns 归一化噪声尺度；观测不足时返回零。
 */
export function noiseScale(points: readonly FitPoint[], periodic: boolean): number {
  if (points.length < 9) return 0;
  // 估噪窗口宽于参数导向窗口，避免相关性抖动被导向本身跟随后低估噪声。
  const halfWindow = Math.min(8, Math.floor((points.length - 1) / 4)),
    pilot = pilotContour(points, periodic, halfWindow),
    centralWeight =
      (3 * (3 * halfWindow ** 2 + 3 * halfWindow - 1)) /
      ((2 * halfWindow + 3) * (2 * halfWindow + 1) * (2 * halfWindow - 1));
  const residuals = points.flatMap((point, i) => {
    if (!periodic && (i < halfWindow || i >= points.length - halfWindow)) return [];
    const before = pilot[(i - 1 + pilot.length) % pilot.length]!,
      after = pilot[(i + 1) % pilot.length]!,
      length = distance(before, after);
    return length > 1e-8
      ? [
          Math.abs(
            (point.x - pilot[i]!.x) * (after.y - before.y) -
              (point.y - pilot[i]!.y) * (after.x - before.x),
          ) / length,
        ]
      : [];
  });
  // 正态绝对残差的中位数恢复尺度，并补偿SG滤波中心权重；孤立尖角不抬高整条曲线噪声预算。
  return residuals.length ? (median(residuals) * 1.4826) / Math.sqrt(1 - centralWeight) : 0;
}

/**
 * 从已证明的几何族的有符号残差估计MAD噪声，长相关性抖动不依赖局部窗口猜测。
 * @param residuals 同一几何下的完整等弧长残差。
 * @returns 正态一致的有限鲁棒尺度；空输入返回零。
 */
export function residualNoise(residuals: readonly number[]): number {
  if (!residuals.length) return 0;
  const center = median(residuals);
  return 1.4826 * median(residuals.map((value) => Math.abs(value - center)));
}
