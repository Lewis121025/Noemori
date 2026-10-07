import { contourHull, distance, type FitPoint } from "./fitting-math";
import { stabilizeTrace } from "./stabilization";
import { refinePolyline } from "./fitting-lines";
import { straightEvidence } from "./fitting-straight-evidence";

/**
 * 从有噪声的凸边界建立直边候选；包络上的圆滑拐点不作为真实尖角身份。
 * @param sampled 同一归一化框架的完整等弧长采样。
 * @param uncertainty 定位不确定性，供鲁棒支持线估计。
 * @param noise 实测噪声尺度，决定包络的分辨率；不能用预设类别替代。
 * @returns 每条长边均有直线统计证据的闭合轮廓；连续弯边或退化返回null。
 * @throws 数值错误传播；外层仍验证全观测、双向覆盖和完整绕行。
 */
export function convexLineContour(
  sampled: readonly FitPoint[],
  uncertainty: number,
  noise: number,
): FitPoint[] | null {
  const hull = contourHull(sampled);
  if (hull.length < 3) return null;
  const loop = stabilizeTrace([...hull, hull[0]!], Math.max(0.015, Math.min(0.075, noise * 3)));
  if (loop.length < 4 || loop.length > 25 || distance(loop[0]!, loop.at(-1)!) > 1e-8) return null;
  const fitted = refinePolyline(sampled, loop, uncertainty);
  if (!fitted) return null;
  return fitted.slice(1).every((point, i) => straightEvidence(sampled, fitted[i]!, point))
    ? fitted
    : null;
}
