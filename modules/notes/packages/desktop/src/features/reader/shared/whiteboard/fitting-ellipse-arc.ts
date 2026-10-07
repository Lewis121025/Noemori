import { ellipseContour, fitEllipseGeometry } from "./fitting-conics";
import { angleAdvance, type FitPoint } from "./fitting-math";

/**
 * 使用与闭合椭圆相同的几何距离、解析导数和完整观测约束，恢复开放椭圆弧的参数。
 * @param sampled 等弧长有限归一化采样，调用方已确认当前轮廓开放。
 * @param trace 保留原顺序的去抖轨迹；大范围折返或近整圈不能解释成开放弧。
 * @param observations 全部原始观测，不能通过归并隐藏额外笔画。
 * @param contour 完整静态轮廓，覆盖验收与优化使用同一有限弧段。
 * @param uncertainty 归一化位置不确定性。
 * @returns 同一椭圆上的有限点列；退化或顺序不符返回null，数值异常向上传播。
 */
export function fitEllipseArc(
  sampled: readonly FitPoint[],
  trace: readonly FitPoint[],
  observations: readonly FitPoint[],
  contour: readonly FitPoint[],
  uncertainty: number,
): FitPoint[] | null {
  const fit = fitEllipseGeometry(sampled, uncertainty, observations, contour, false);
  if (!fit || fit.minor < 0.04 || fit.major > 3) return null;
  const dx = Math.cos(fit.angle),
    dy = Math.sin(fit.angle),
    angle = (point: FitPoint) =>
      Math.atan2(
        (-(point.x - fit.center.x) * dy + (point.y - fit.center.y) * dx) / fit.minor,
        ((point.x - fit.center.x) * dx + (point.y - fit.center.y) * dy) / fit.major,
      );
  const sweep = angleAdvance(trace.map(angle));
  if (sweep === null || Math.abs(sweep) < 0.4 || Math.abs(sweep) > Math.PI * 1.9) return null;
  return ellipseContour(fit, angle(sampled[0]!), sweep);
}
