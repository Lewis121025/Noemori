import { distance, segmentDistance, type FitPoint } from "./fitting-math";

/**
 * 为拟合候选移除有界微抖；同时约束位置误差和有序推进，不能把共线往返压成直线。
 * @param points 已校验的有限归一化采样；调用方先限制数量，不修改输入或端点。
 * @param tolerance 非负有限半径；垂直偏差和投影折返分别按该半径约束，零半径保留全部点。
 * @returns 按原顺序保留的候选点；实际修复必须再与完整原始轨迹校验。
 * @throws 半径为负或非有限时抛RangeError，避免无效参数悄悄移除轨迹。
 */
export function stabilizeTrace(points: readonly FitPoint[], tolerance: number): FitPoint[] {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError("轨迹去抖半径无效");
  if (points.length < 3 || tolerance === 0) return [...points];
  const kept = Array<boolean>(points.length).fill(false);
  kept[0] = kept[points.length - 1] = true;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [start, end] = pending.pop()!;
    const a = points[start]!,
      b = points[end]!,
      length = distance(a, b);
    let maximum = tolerance,
      split = -1,
      furthest = 0,
      peak = start;
    for (let i = start + 1; i < end; i++) {
      const point = points[i]!;
      const deviation = segmentDistance(point, a, b);
      if (deviation > maximum) {
        maximum = deviation;
        split = i;
      }
      const along =
        length === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                length,
                ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length,
              ),
            );
      if (along > furthest) {
        furthest = along;
        peak = i;
      }
      // 若折返超过两个半径，任何单调线段都无法在该误差内代表两次访问。
      const reversed = (furthest - along) / 2;
      if (reversed > maximum) {
        maximum = reversed;
        split = peak;
      }
    }
    if (split > start && split < end) {
      kept[split] = true;
      pending.push([start, split], [split, end]);
    }
  }
  return points.filter((_, i) => kept[i]);
}
