import {
  circleContour,
  ellipseContour,
  fitCircleGeometry,
  fitEllipseGeometry,
} from "./fitting-conics";
import { fitFreeCurve } from "./fitting-curves";
import { noiseScale } from "./fitting-noise";
import {
  angleAdvance,
  contourDeviation,
  distance,
  leastSquares,
  resample,
  type FitPoint,
} from "./fitting-math";
import type { GraphTrace } from "./fitting-scene-graph";

/** 主干端点的向外切线与规范点列来自同一几何，箭翼不得使用长弦方向代替。 */
export type ArrowShaft = { points: FitPoint[]; from: FitPoint; to: FitPoint };
const unit = (x: number, y: number): FitPoint => {
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
};
/** 三次单侧回归仅用于没有解析族的样条；固定端点下估计向外切线。 */
function endpointDirection(points: readonly FitPoint[]): FitPoint | null {
  if (points.length < 4) {
    const first = points[0]!,
      last = points.at(-1)!;
    return distance(first, last) > 1e-8 ? unit(first.x - last.x, first.y - last.y) : null;
  }
  const part = points.slice(0, Math.min(6, points.length)),
    lengths = [0];
  for (let i = 1; i < part.length; i++)
    lengths.push(lengths.at(-1)! + distance(part[i - 1]!, part[i]!));
  const total = lengths.at(-1)!;
  if (total < 1e-8) return null;
  const rows = lengths.slice(1).map((t) => [t / total, (t / total) ** 2, (t / total) ** 3]),
    first = part[0]!,
    x = leastSquares(
      rows,
      part.slice(1).map((p) => p.x - first.x),
    ),
    y = leastSquares(
      rows,
      part.slice(1).map((p) => p.y - first.y),
    );
  return x && y && Math.hypot(x[0]!, y[0]!) > 1e-8 ? unit(-x[0]!, -y[0]!) : null;
}
/**
 * 规范主干并保留解析端点切线；清晰圆弧/椭圆弧先拟合真实几何，其余使用保形样条。
 * @param trace 同坐标的完整静态主干与观测。
 * @param uncertainty 归一化定位预算。
 * @returns 同一几何的点列与两端向外切线；退化或无法保形返回null。
 * @throws 数值错误传播，整个箭头仍须全观测验收。
 */
export function fitArrowShaft(trace: GraphTrace, uncertainty: number): ArrowShaft | null {
  const sampled = resample(trace.points, 192),
    straight = [trace.points[0]!, trace.points.at(-1)!],
    error = contourDeviation(trace.points, straight);
  if (error && error.rms < 0.018 && error.maximum < 0.06) {
    const from = unit(straight[0]!.x - straight[1]!.x, straight[0]!.y - straight[1]!.y);
    return { points: straight, from, to: { x: -from.x, y: -from.y } };
  }
  const budget = Math.max(0.002, noiseScale(sampled, false) * 2.5),
    agrees = (points: FitPoint[]) => {
      const error = contourDeviation(trace.points, points);
      return error && error.rms < budget && error.maximum < 0.06;
    };
  const circle = fitCircleGeometry(sampled, uncertainty, trace.observations, trace.points);
  if (circle) {
    const angles = sampled.map((p) => Math.atan2(p.y - circle.center.y, p.x - circle.center.x)),
      sweep = angleAdvance(angles);
    if (sweep !== null && Math.abs(sweep) > 0.4 && Math.abs(sweep) < 1.9 * Math.PI) {
      const start = angles[0]!,
        points = circleContour(circle, start, sweep),
        sign = Math.sign(sweep);
      if (agrees(points))
        return {
          points,
          from: unit(sign * Math.sin(start), -sign * Math.cos(start)),
          to: unit(-sign * Math.sin(start + sweep), sign * Math.cos(start + sweep)),
        };
    }
  }
  const ellipse = fitEllipseGeometry(sampled, uncertainty, trace.observations, trace.points, false);
  if (ellipse) {
    const c = Math.cos(ellipse.angle),
      s = Math.sin(ellipse.angle),
      angle = (p: FitPoint) =>
        Math.atan2(
          (-(p.x - ellipse.center.x) * s + (p.y - ellipse.center.y) * c) / ellipse.minor,
          ((p.x - ellipse.center.x) * c + (p.y - ellipse.center.y) * s) / ellipse.major,
        ),
      angles = sampled.map(angle),
      sweep = angleAdvance(angles);
    if (sweep !== null && Math.abs(sweep) > 0.4 && Math.abs(sweep) < 1.9 * Math.PI) {
      const start = angles[0]!,
        points = ellipseContour(ellipse, start, sweep),
        tangent = (at: number, sign: number) =>
          unit(
            sign * (-ellipse.major * Math.sin(at) * c - ellipse.minor * Math.cos(at) * s),
            sign * (-ellipse.major * Math.sin(at) * s + ellipse.minor * Math.cos(at) * c),
          );
      if (agrees(points))
        return {
          points,
          from: tangent(start, -Math.sign(sweep)),
          to: tangent(start + sweep, Math.sign(sweep)),
        };
    }
  }
  const points = fitFreeCurve(sampled, trace.points, trace.observations, uncertainty, 0.0008);
  if (!points) return null;
  const from = endpointDirection(points),
    to = endpointDirection([...points].reverse());
  return from && to ? { points, from, to } : null;
}
