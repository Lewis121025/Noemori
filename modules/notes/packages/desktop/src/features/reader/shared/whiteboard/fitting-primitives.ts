import { fitLineGeometry, type LineGeometry } from "./fitting-lines";
import {
  fitCircleGeometry,
  fitEllipseGeometry,
  circleContour,
  ellipseContour,
  type CircleGeometry,
  type EllipseGeometry,
} from "./fitting-conics";
import {
  angleAdvance,
  contourDeviation,
  distance,
  observationsAgree,
  resample,
  traceAdvance,
  type FitPoint,
} from "./fitting-math";
import type { GraphTrace } from "./fitting-scene-graph";

/** 基元保留原笔画身份；复合拟合从真实结构出发，不读取分类标签。 */
export type ScenePrimitive =
  | { kind: "line"; trace: GraphTrace; geometry: LineGeometry; points: FitPoint[] }
  | { kind: "circle"; trace: GraphTrace; geometry: CircleGeometry; points: FitPoint[] }
  | {
      kind: "ellipse";
      trace: GraphTrace;
      geometry: EllipseGeometry;
      points: FitPoint[];
      sweep: number;
      start: number;
    };

/** 把端点正交投影到同一无限直线，返回顺序与输入一致的有限线段。 */
export function lineEndpoints(trace: GraphTrace, fit: LineGeometry): FitPoint[] {
  const d = { x: Math.cos(fit.angle), y: Math.sin(fit.angle) };
  return [trace.points[0]!, trace.points.at(-1)!].map((p) => {
    const t = (p.x - fit.center.x) * d.x + (p.y - fit.center.y) * d.y;
    return { x: fit.center.x + t * d.x, y: fit.center.y + t * d.y };
  });
}
/**
 * 为组合图形提取经全观测验证的线/圆/椭圆基元；不是提前锁定图形类别。
 * @param trace 归一化点列、顺序与完整观测。
 * @param uncertainty 归一化实测定位预算。
 * @returns 可信基本几何；折返、重复圈、遗漏轮廓或退化返回null。
 * @throws 数值错误向上传播。
 */
export function scenePrimitive(trace: GraphTrace, uncertainty: number): ScenePrimitive | null {
  const sampled = resample(trace.points, 96),
    closed = distance(sampled[0]!, sampled.at(-1)!) < 0.05;
  const agrees = (points: FitPoint[]) => {
    const error = contourDeviation(trace.points, points);
    return (
      error &&
      error.rms < 0.018 &&
      error.maximum < 0.06 &&
      observationsAgree(trace.observations, points, 0.06)
    );
  };
  if (!closed) {
    const geometry = fitLineGeometry(sampled, uncertainty);
    if (!geometry) return null;
    const points = lineEndpoints(trace, geometry),
      dx = Math.cos(geometry.angle),
      dy = Math.sin(geometry.angle);
    const advance = traceAdvance(
      sampled.slice(1).map((p, i) => (p.x - sampled[i]!.x) * dx + (p.y - sampled[i]!.y) * dy),
    );
    if (advance !== null && agrees(points)) return { kind: "line", trace, geometry, points };
  }
  const circle = closed
    ? fitCircleGeometry(sampled, uncertainty, trace.observations, trace.points)
    : null;
  if (circle) {
    const angles = sampled.map((p) => Math.atan2(p.y - circle.center.y, p.x - circle.center.x)),
      sweep = angleAdvance(angles);
    const points = circleContour(circle, angles[0]!, Math.sign(sweep ?? 0) * 2 * Math.PI);
    if (sweep !== null && Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.4 && agrees(points))
      return { kind: "circle", trace, geometry: circle, points };
  }
  const ellipse = fitEllipseGeometry(
    sampled,
    uncertainty,
    trace.observations,
    trace.points,
    closed,
  );
  if (!ellipse) return null;
  const angle = (p: FitPoint) => {
    const x = p.x - ellipse.center.x,
      y = p.y - ellipse.center.y;
    return Math.atan2(
      (-x * Math.sin(ellipse.angle) + y * Math.cos(ellipse.angle)) / ellipse.minor,
      (x * Math.cos(ellipse.angle) + y * Math.sin(ellipse.angle)) / ellipse.major,
    );
  };
  const sweep = angleAdvance(sampled.map(angle)),
    points = ellipseContour(
      ellipse,
      angle(sampled[0]!),
      closed ? Math.sign(sweep ?? 0) * 2 * Math.PI : (sweep ?? 0),
    );
  return sweep !== null &&
    (closed
      ? Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.4
      : Math.abs(sweep) > 1.4 && Math.abs(sweep) < 1.9 * Math.PI) &&
    agrees(points)
    ? {
        kind: "ellipse",
        trace,
        geometry: ellipse,
        points,
        sweep: closed ? Math.sign(sweep) * 2 * Math.PI : sweep,
        start: angle(sampled[0]!),
      }
    : null;
}
