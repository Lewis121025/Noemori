import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import { RECOGNITION_POINT_LIMIT, type ShapePrediction } from "./recognition";
import { fitArrow } from "./fitting-arrow";
import {
  distance,
  angleAdvance,
  contourHull,
  fitAgrees,
  leastSquares,
  principalLine,
  perimeterAdvance,
  resample,
  traceAdvance,
  type FitPoint,
} from "./fitting-math";

/** 单路径验证集上的联合门槛；多数模型候选还必须通过完整几何约束与双向轮廓检查。 */
export const MIN_SHAPE_SCORE = 0.5;

function line(points: readonly FitPoint[]): FitPoint[] | null {
  const fit = principalLine(points);
  if (!fit) return null;
  const dx = Math.cos(fit.angle),
    dy = Math.sin(fit.angle);
  const along = (p: FitPoint) => (p.x - fit.center.x) * dx + (p.y - fit.center.y) * dy;
  const project = (p: FitPoint) => {
    const t = along(p);
    return { x: fit.center.x + t * dx, y: fit.center.y + t * dy };
  };
  const result = [project(points[0]!), project(points.at(-1)!)];
  // 横向于主轴的手抖不能当成涂划；只有主轴上的往返才消耗净推进比例。
  const advance = traceAdvance(points.slice(1).map((p, i) => along(p) - along(points[i]!)));
  return advance === null ? null : result;
}

function closed(points: readonly FitPoint[]): boolean {
  return distance(points[0]!, points.at(-1)!) <= 0.12;
}

function circle(points: readonly FitPoint[], arc: boolean): FitPoint[] | null {
  if (!arc && !closed(points)) return null;
  const solution = leastSquares(
    points.map((p) => [2 * p.x, 2 * p.y, 1]),
    points.map((p) => p.x * p.x + p.y * p.y),
  );
  if (!solution) return null;
  const [cx, cy, constant] = solution;
  const radius = Math.sqrt(constant! + cx! * cx! + cy! * cy!);
  if (!Number.isFinite(radius) || radius < 0.08 || radius > 3) return null;
  const angles = points.map((p) => Math.atan2(p.y - cy!, p.x - cx!));
  let sweep = angleAdvance(angles);
  if (sweep === null) return null;
  if (
    arc
      ? Math.abs(sweep) < 0.4 || Math.abs(sweep) > Math.PI * 1.9
      : Math.abs(Math.abs(sweep) - Math.PI * 2) > 0.4
  )
    return null;
  if (!arc) sweep = Math.sign(sweep) * Math.PI * 2;
  const result = Array.from({ length: 129 }, (_, i) => {
    const angle = angles[0]! + (sweep * i) / 128;
    return { x: cx! + radius * Math.cos(angle), y: cy! + radius * Math.sin(angle) };
  });
  if (!arc) result[result.length - 1] = result[0]!;
  return result;
}

function ellipse(points: readonly FitPoint[]): FitPoint[] | null {
  if (!closed(points)) return null;
  const fit = leastSquares(
    points.map((p) => [p.x * p.x, p.x * p.y, p.y * p.y, p.x, p.y]),
    points.map(() => 1),
  );
  if (!fit) return null;
  const [a, b, c, d, e] = fit;
  const determinant = a! * c! - (b! * b!) / 4;
  if (a! <= 0 || c! <= 0 || determinant <= 1e-8) return null;
  const cx = ((b! * e!) / 2 - c! * d!) / (2 * determinant);
  const cy = ((b! * d!) / 2 - a! * e!) / (2 * determinant);
  const scale = 1 + a! * cx * cx + b! * cx * cy + c! * cy * cy;
  const discriminant = Math.hypot(a! - c!, b!);
  const major = Math.sqrt(scale / ((a! + c! - discriminant) / 2));
  const minor = Math.sqrt(scale / ((a! + c! + discriminant) / 2));
  if (![major, minor].every(Number.isFinite) || minor < 0.04 || major > 1.5) return null;
  const rotation = Math.atan2(b!, a! - c!) / 2 + Math.PI / 2;
  const dx = Math.cos(rotation),
    dy = Math.sin(rotation);
  const angleAt = (p: FitPoint) =>
    Math.atan2(
      (-(p.x - cx) * dy + (p.y - cy) * dx) / minor,
      ((p.x - cx) * dx + (p.y - cy) * dy) / major,
    );
  const start = angleAt(points[0]!);
  const sweep = angleAdvance(points.map(angleAt));
  if (sweep === null || Math.abs(Math.abs(sweep) - Math.PI * 2) > 0.4) return null;
  const result = Array.from({ length: 129 }, (_, i) => {
    const angle = start + (Math.sign(sweep) * 2 * Math.PI * i) / 128;
    const x = major * Math.cos(angle),
      y = minor * Math.sin(angle);
    return { x: cx + x * dx - y * dy, y: cy + x * dy + y * dx };
  });
  result[result.length - 1] = result[0]!;
  return result;
}

function rectangle(points: readonly FitPoint[]): FitPoint[] | null {
  if (!closed(points)) return null;
  let area = Infinity,
    result: FitPoint[] | null = null;
  // 对任意方向取最小包围矩形；正方形也不依赖没有唯一方向的 PCA。
  for (let step = 0; step < 180; step++) {
    const angle = (step * Math.PI) / 360,
      dx = Math.cos(angle),
      dy = Math.sin(angle);
    const local = points.map((p) => ({ x: p.x * dx + p.y * dy, y: -p.x * dy + p.y * dx }));
    const left = Math.min(...local.map((p) => p.x)),
      right = Math.max(...local.map((p) => p.x));
    const top = Math.min(...local.map((p) => p.y)),
      bottom = Math.max(...local.map((p) => p.y));
    const current = (right - left) * (bottom - top);
    if (current >= area || Math.min(right - left, bottom - top) < 0.08) continue;
    area = current;
    result = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top],
    ].map(([x, y]) => ({ x: x! * dx - y! * dy, y: x! * dy + y! * dx }));
  }
  return result;
}

function triangle(points: readonly FitPoint[]): FitPoint[] | null {
  if (!closed(points)) return null;
  // 顶点属于可见边界，不属于访问顺序；回描不能制造额外的几何角点。
  const hull = contourHull(points);
  if (hull.length < 3) return null;
  let area = 0,
    vertices: FitPoint[] = [];
  // 已由模型选定三角形族；最大面积三点保留主体角点，边上细小凸起不增加边数。
  // 凸包至多包含192个重采样点，后续仍用原始轮廓拒绝矩形、缺边与额外笔画。
  for (let i = 0; i < hull.length - 2; i++) {
    const a = hull[i]!;
    for (let j = i + 1; j < hull.length - 1; j++) {
      const b = hull[j]!;
      for (let k = j + 1; k < hull.length; k++) {
        const c = hull[k]!;
        const current = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        if (current > area) {
          area = current;
          vertices = [a, b, c];
        }
      }
    }
  }
  if (area < 0.08) return null;
  const result = [...vertices, vertices[0]!];
  const advance = perimeterAdvance(points, result);
  return advance === null || Math.abs(Math.abs(advance) - 1) > 0.4 / (2 * Math.PI) ? null : result;
}

/**
 * 分类只决定拟合族，拟合使用原始向量；低置信度、退化或轮廓不符返回 null。
 * @param points 一个连续笔迹的已校验世界坐标，不修改原始采样。
 * @param prediction 静态模型候选；分数仅作入口门槛，不能代替几何证据。
 * @param scale 屏幕缩放，仅用于拒绝不到 16 CSS 像素的细小图形。
 * @returns 可存入原有笔迹格式的规范轮廓；拟合还需通过双向距离和覆盖检查。
 */
export function fitShape(
  points: readonly InkPoint[],
  prediction: ShapePrediction,
  scale: number,
): InkPoint[] | null {
  if (
    points.length < 2 ||
    points.length > RECOGNITION_POINT_LIMIT ||
    prediction.label === "other" ||
    !Number.isFinite(prediction.confidence) ||
    prediction.confidence < MIN_SHAPE_SCORE ||
    prediction.confidence > 1 ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    return null;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  const size = Math.max(right - left, bottom - top);
  if (!Number.isFinite(size) || size * scale < 16) return null;
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  const normalized = points.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }));
  const sampled = resample(normalized, 192);
  if (sampled.length === 0) return null;
  const fitters = {
    line,
    circle: (p: readonly FitPoint[]) => circle(p, false),
    ellipse,
    arc: (p: readonly FitPoint[]) => circle(p, true),
    rectangle,
    triangle,
    arrow: fitArrow,
  };
  const fitted = fitters[prediction.label](sampled);
  if (!fitted || !fitAgrees(normalized, fitted)) return null;
  const pressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
  const result = fitted.map((p) => ({ x: cx + p.x * size, y: cy + p.y * size, pressure }));
  return result.every(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Math.abs(p.x) <= BOARD_COORDINATE_LIMIT &&
      Math.abs(p.y) <= BOARD_COORDINATE_LIMIT,
  )
    ? result
    : null;
}
