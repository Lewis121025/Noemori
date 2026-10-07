import { resample, type FitPoint } from "./fitting-math";

/** 双向渲染轮廓的距离及参数导数，观测顺序不参与平均权重，仅约束完整覆盖。 */
export type Coverage = { errors: number[]; jacobian: number[][] };
/** 参数产生与最终渲染相同的点列；非法参数返回null，不能删点或补造观测。 */
type RenderContour = (parameters: readonly number[]) => FitPoint[] | null;

/** 最近线段投影用于ICP包络导数，零距离使用零梯度，不给重合点制造方向。 */
function projection(point: FitPoint, contour: readonly FitPoint[]) {
  let best = Infinity,
    index = 0,
    fraction = 0,
    nx = 0,
    ny = 0;
  for (let i = 1; i < contour.length; i++) {
    const a = contour[i - 1]!,
      b = contour[i]!,
      dx = b.x - a.x,
      dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t =
      squared > 0
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared))
        : 0;
    const x = point.x - a.x - t * dx,
      y = point.y - a.y - t * dy;
    const distance = Math.hypot(x, y);
    if (distance < best) {
      best = distance;
      index = i - 1;
      fraction = t;
      nx = distance > 0 ? x / distance : 0;
      ny = distance > 0 ? y / distance : 0;
    }
  }
  return { distance: best, index, fraction, nx, ny };
}

/**
 * 对实际渲染点列做双向覆盖约束；只对采样位置求有限差分，最近点导数由投影法向给出。
 * @param parameters 有限几何参数。
 * @param render 与最终输出共用的规范轮廓生成函数。
 * @param source 完整静态笔迹，反方向检查不能只用其简化版本。
 * @param observed 全部真实观测与等弧长采样，共同约束到渲染点列的偏差。
 * @returns 双向距离与雅可比；退化轮廓或非法参数返回null，不修改输入。
 */
export function renderedCoverage(
  parameters: readonly number[],
  render: RenderContour,
  source: readonly FitPoint[],
  observed: readonly FitPoint[],
): Coverage | null {
  const contour = render(parameters);
  if (!contour || contour.length < 2 || source.length < 2) return null;
  const sampled = resample(contour, 192);
  if (sampled.length !== 192) return null;
  const shifts = parameters.map((value, j) => {
    const h = 1e-6 * (1 + Math.abs(value)),
      p = [...parameters];
    p[j] = value + h;
    const shifted = render(p);
    if (!shifted || shifted.length !== contour.length) return null;
    const samples = resample(shifted, 192);
    return samples.length === sampled.length ? { contour: shifted, sampled: samples, h } : null;
  });
  const valid = shifts.filter((shift) => shift !== null);
  if (valid.length !== parameters.length) return null;
  const errors: number[] = [],
    jacobian: number[][] = [];
  for (const point of observed) {
    const nearest = projection(point, contour),
      a = contour[nearest.index]!,
      b = contour[nearest.index + 1]!;
    errors.push(nearest.distance);
    jacobian.push(
      valid.map((shift) => {
        const u = shift.contour[nearest.index]!,
          v = shift.contour[nearest.index + 1]!;
        const dx =
          ((1 - nearest.fraction) * (u.x - a.x) + nearest.fraction * (v.x - b.x)) / shift.h;
        const dy =
          ((1 - nearest.fraction) * (u.y - a.y) + nearest.fraction * (v.y - b.y)) / shift.h;
        return -nearest.nx * dx - nearest.ny * dy;
      }),
    );
  }
  sampled.forEach((point, i) => {
    const nearest = projection(point, source);
    errors.push(nearest.distance);
    jacobian.push(
      valid.map(
        (shift) =>
          (nearest.nx * (shift.sampled[i]!.x - point.x)) / shift.h +
          (nearest.ny * (shift.sampled[i]!.y - point.y)) / shift.h,
      ),
    );
  });
  return { errors, jacobian };
}
