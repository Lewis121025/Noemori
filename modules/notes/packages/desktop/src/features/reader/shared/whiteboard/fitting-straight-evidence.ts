import { leastSquares, type FitPoint } from "./fitting-math";

/**
 * 用二次回归的曲率置信区间验证真正直边，不能把连续弯边当成圆角多边形的直段。
 * @param points 等弧长有限归一化轮廓。
 * @param a 候选直边起点。
 * @param b 候选直边终点。
 * @param requireResolved 为true时整个曲率置信区间必须落入直线容差；噪声过大而不能排除曲率不算证明。
 * @returns 有完整边中段支持且曲率与零相容时为true；短边或退化返回false。
 * @throws 数值库错误向上传播。
 */
export function straightEvidence(
  points: readonly FitPoint[],
  a: FitPoint,
  b: FitPoint,
  requireResolved = false,
): boolean {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  if (length < 0.05) return false;
  const local = points
    .map((p) => ({
      x: ((p.x - a.x) * dx + (p.y - a.y) * dy) / length,
      y: ((p.y - a.y) * dx - (p.x - a.x) * dy) / length,
    }))
    .filter((p) => p.x > length * 0.12 && p.x < length * 0.88 && Math.abs(p.y) < 0.04);
  if (
    local.length < 7 ||
    Math.max(...local.map((p) => p.x)) - Math.min(...local.map((p) => p.x)) < length * 0.6
  )
    return false;
  const rows = local.map((p) => [p.x * p.x, p.x, 1]),
    fit = leastSquares(
      rows,
      local.map((p) => p.y),
    );
  if (!fit) return false;
  const variance =
      local.reduce(
        (sum, p) => sum + (p.y - fit[0]! * p.x * p.x - fit[1]! * p.x - fit[2]!) ** 2,
        0,
      ) /
      (local.length - 3),
    weights = local.map(
      (_, j) =>
        leastSquares(
          rows,
          local.map((_, i) => (i === j ? 1 : 0)),
        )?.[0] ?? Infinity,
    ),
    se = Math.sqrt(variance * weights.reduce((sum, w) => sum + w * w, 0));
  const tolerance = 0.0006 / (length * length);
  return requireResolved
    ? Math.abs(fit[0]!) + 2.5 * se <= tolerance
    : Math.abs(fit[0]!) <= 2.5 * se + tolerance;
}
