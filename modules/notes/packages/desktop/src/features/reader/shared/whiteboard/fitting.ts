import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import { RECOGNITION_POINT_LIMIT, type ShapePrediction } from "./recognition";
import {
  distance,
  fitAgrees,
  leastSquares,
  principalLine,
  resample,
  simplify,
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
  const traveled = points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.abs(along(p) - along(points[i]!)), 0);
  return Math.abs(along(points.at(-1)!) - along(points[0]!)) >= traveled * 0.9 ? result : null;
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
  let sweep = 0,
    travel = 0;
  for (let i = 1; i < angles.length; i++) {
    const delta = Math.atan2(
      Math.sin(angles[i]! - angles[i - 1]!),
      Math.cos(angles[i]! - angles[i - 1]!),
    );
    sweep += delta;
    travel += Math.abs(delta);
  }
  if (Math.abs(sweep) < travel * 0.9) return null;
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
  let sweep = 0,
    travel = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = angleAt(points[i]!) - angleAt(points[i - 1]!);
    const wrapped = Math.atan2(Math.sin(delta), Math.cos(delta));
    sweep += wrapped;
    travel += Math.abs(wrapped);
  }
  if (Math.abs(sweep) < travel * 0.9 || Math.abs(Math.abs(sweep) - Math.PI * 2) > 0.4) return null;
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
  const start = points[0]!;
  let split = 1;
  for (let i = 2; i < points.length; i++)
    if (distance(start, points[i]!) > distance(start, points[split]!)) split = i;
  const ring = [...points.slice(0, -1), start];
  const vertices = [
    ...simplify(ring.slice(0, split + 1), 0.04).slice(0, -1),
    ...simplify(ring.slice(split), 0.04).slice(0, -1),
  ];
  // 起笔可能在边中间，环形简化必须也检查跨越起点的那一条边。
  let changed = true;
  while (vertices.length > 3 && changed) {
    changed = false;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[(i + vertices.length - 1) % vertices.length]!,
        p = vertices[i]!;
      const b = vertices[(i + 1) % vertices.length]!;
      const deviation =
        Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / distance(a, b);
      if (deviation < 0.04) {
        vertices.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (vertices.length !== 3) return null;
  const [a, b, c] = vertices;
  const area = Math.abs((b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x));
  return area < 0.08 ? null : [...vertices, vertices[0]!];
}

function arrow(points: readonly FitPoint[]): FitPoint[] | null {
  const vertices = simplify(points, 0.035);
  if (vertices.length !== 5) return null;
  const [first, tip, middle, returned, last] = vertices;
  if (distance(tip!, returned!) > 0.07) return null;
  const ends = [first!, middle!, last!].sort((a, b) => distance(b, tip!) - distance(a, tip!));
  const [start, left, right] = ends;
  const length = distance(start!, tip!);
  if (length < 0.5) return null;
  const dx = (tip!.x - start!.x) / length,
    dy = (tip!.y - start!.y) / length;
  const wings = [left!, right!].map((p) => ({
    x: (p.x - tip!.x) * dx + (p.y - tip!.y) * dy,
    y: -(p.x - tip!.x) * dy + (p.y - tip!.y) * dx,
  }));
  if (wings[0]!.y * wings[1]!.y >= 0 || wings.some((p) => p.x > -0.06)) return null;
  const head = -(wings[0]!.x + wings[1]!.x) / 2;
  const width = (Math.abs(wings[0]!.y) + Math.abs(wings[1]!.y)) / 2;
  if (head > length * 0.45 || width < 0.04 || width > length * 0.4) return null;
  const wing = (side: number) => ({
    x: tip!.x - head * dx - side * width * dy,
    y: tip!.y - head * dy + side * width * dx,
  });
  return [start!, tip!, wing(Math.sign(wings[0]!.y)), tip!, wing(Math.sign(wings[1]!.y))];
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
    arrow,
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
