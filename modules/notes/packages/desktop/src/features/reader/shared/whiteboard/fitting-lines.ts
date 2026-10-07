import { distance, principalLine, segmentDistance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";

/** 鲁棒直线使用单位方向与法向偏移，避免斜率参数在垂直方向退化。 */
export type LineGeometry = { center: FitPoint; angle: number };

/**
 * 由正交TLS初始化，以Huber垂直距离优化直线，减少局部尾巴与偏向一侧的抖动拉偏整体方向。
 * @param points 已校验的有限归一化点，至少两个不同位置。
 * @param uncertainty 归一化位置不确定性。
 * @returns 单位方向及线上参考点；零方差返回null，数值库异常向上传播。
 */
export function fitLineGeometry(
  points: readonly FitPoint[],
  uncertainty: number,
): LineGeometry | null {
  const initial = principalLine(points);
  if (!initial) return null;
  const offset =
    initial.center.y * Math.cos(initial.angle) - initial.center.x * Math.sin(initial.angle);
  const fitted = optimizeGeometry(
    [initial.angle, offset],
    (p) => points.map((point) => point.y * Math.cos(p[0]!) - point.x * Math.sin(p[0]!) - p[1]!),
    uncertainty,
  );
  if (!fitted) return null;
  return {
    angle: fitted[0]!,
    center: { x: -Math.sin(fitted[0]!) * fitted[1]!, y: Math.cos(fitted[0]!) * fitted[1]! },
  };
}

/**
 * 五参数矩形按真实边界距离联合优化；平行、垂直与闭合是参数化约束，不靠四边分别凑直角。
 * @param points 完整有限归一化观测。
 * @param initial 五点闭合矩形初值，首尾同点且相邻边非退化。
 * @param uncertainty 归一化位置不确定性。
 * @returns 规范五点矩形；极细或退化返回null，数值库异常向上传播。
 */
export function refineRectangle(
  points: readonly FitPoint[],
  initial: readonly FitPoint[],
  uncertainty: number,
): FitPoint[] | null {
  const [a, b, c] = initial;
  if (!a || !b || !c) return null;
  const width = distance(a, b),
    height = distance(b, c);
  const center = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
  const fitted = optimizeGeometry(
    [
      center.x,
      center.y,
      Math.log(width / 2),
      Math.log(height / 2),
      Math.atan2(b.y - a.y, b.x - a.x),
    ],
    (p) => {
      const halfWidth = Math.exp(p[2]!),
        halfHeight = Math.exp(p[3]!);
      if (!(halfWidth > 0 && halfHeight > 0) || !Number.isFinite(halfWidth + halfHeight))
        return null;
      return points.map((point) => {
        const x = point.x - p[0]!,
          y = point.y - p[1]!;
        const u = Math.abs(x * Math.cos(p[4]!) + y * Math.sin(p[4]!)) - halfWidth;
        const v = Math.abs(-x * Math.sin(p[4]!) + y * Math.cos(p[4]!)) - halfHeight;
        return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
      });
    },
    uncertainty,
  );
  if (!fitted || Math.min(Math.exp(fitted[2]!), Math.exp(fitted[3]!)) < 0.04) return null;
  const dx = Math.cos(fitted[4]!),
    dy = Math.sin(fitted[4]!);
  const result = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ].map(([sx, sy]) => {
    const x = sx! * Math.exp(fitted[2]!),
      y = sy! * Math.exp(fitted[3]!);
    return { x: fitted[0]! + x * dx - y * dy, y: fitted[1]! + x * dy + y * dx };
  });
  return result;
}

/**
 * 有序角点确定边段结构，边的鲁棒TLS交点估计顶点位置；不依赖固定多边形类别。
 * @param points 完整有限归一化观测，最终仍由调用方检查逐点偏差与绕行。
 * @param contour 至少三点的角点轮廓；首尾同点表示闭合，自交拓扑由调用方验证。
 * @param uncertainty 归一化位置不确定性。
 * @returns 保持边数与顺序的交点轮廓；支撑不足、近平行或数值退化返回null。
 */
function refinePolylineStep(
  points: readonly FitPoint[],
  contour: readonly FitPoint[],
  uncertainty: number,
): FitPoint[] | null {
  if (contour.length < 3) return null;
  const groups: FitPoint[][] = contour.slice(1).map(() => []);
  for (const point of points) {
    const errors = contour.slice(1).map((end, i) => segmentDistance(point, contour[i]!, end));
    groups[errors.indexOf(Math.min(...errors))]!.push(point);
  }
  const lines = groups.map((group) =>
    group.length >= 3 ? fitLineGeometry(group, uncertainty) : null,
  );
  if (lines.some((line) => line === null)) return null;
  const closed = distance(contour[0]!, contour.at(-1)!) < 1e-8;
  const project = (point: FitPoint, line: LineGeometry): FitPoint => {
    const dx = Math.cos(line.angle),
      dy = Math.sin(line.angle);
    const along = (point.x - line.center.x) * dx + (point.y - line.center.y) * dy;
    return { x: line.center.x + along * dx, y: line.center.y + along * dy };
  };
  const result: FitPoint[] = [];
  for (let i = 0; i < contour.length - (closed ? 1 : 0); i++) {
    if (!closed && (i === 0 || i === contour.length - 1)) {
      result.push(project(contour[i]!, lines[i === 0 ? 0 : lines.length - 1]!));
      continue;
    }
    const a = lines[(i + lines.length - 1) % lines.length]!,
      b = lines[i % lines.length]!;
    const ux = Math.cos(a.angle),
      uy = Math.sin(a.angle),
      vx = Math.cos(b.angle),
      vy = Math.sin(b.angle);
    const determinant = ux * vy - uy * vx;
    if (Math.abs(determinant) < 0.05) return null;
    const t = ((b.center.x - a.center.x) * vy - (b.center.y - a.center.y) * vx) / determinant;
    result.push({ x: a.center.x + t * ux, y: a.center.y + t * uy });
  }
  if (closed) result.push(result[0]!);
  return result.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? result
    : null;
}

/**
 * 对全部边段做有界ICP迭代，每轮重新归属观测并以鲁棒TLS求交点。
 * @param points 有限归一化采样，顺序与全部观测由调用方验证。
 * @param contour 真实角点提供的拓扑初值；首尾同点表示闭合。
 * @param uncertainty 归一化定位预算。
 * @returns 原边数的联合稳定轮廓；任一步退化返回null，不伪造角点。
 * @throws 数值错误传播。
 */
export function refinePolyline(
  points: readonly FitPoint[],
  contour: readonly FitPoint[],
  uncertainty: number,
): FitPoint[] | null {
  let current = [...contour];
  for (let step = 0; step < 6; step++) {
    const refined = refinePolylineStep(points, current, uncertainty);
    if (!refined) return null;
    const movement = Math.max(...refined.map((point, i) => distance(point, current[i]!)));
    current = refined;
    if (movement < 1e-6) break;
  }
  return current;
}
