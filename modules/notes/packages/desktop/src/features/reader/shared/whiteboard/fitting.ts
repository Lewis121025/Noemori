import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import {
  HOLD_RADIUS_CSS_PX,
  RECOGNITION_POINT_LIMIT,
  type ShapeFit,
  type ShapeLabel,
} from "./recognition";
import { fitArrow } from "./fitting-arrow";
import { cornerContour, contourCrossings, regularStar } from "./fitting-corners";
import { stabilizeTrace } from "./stabilization";
import {
  distance,
  angleAdvance,
  contourDeviation,
  observationsAgree,
  leastSquares,
  principalLine,
  contourHull,
  segmentDistance,
  perimeterAdvance,
  resample,
  traceAdvance,
  type FitPoint,
} from "./fitting-math";

export type { ShapeFit } from "./recognition";

/** 所有几何族使用同一原始观测与归一化框架，角点结构允许有界边弯曲。 */
type Candidate = {
  label: ShapeLabel;
  points: FitPoint[];
  parameters: number;
  curvedSides?: boolean;
  sourceCorners?: boolean;
};
function line(points: readonly FitPoint[], trace: readonly FitPoint[]): FitPoint[] | null {
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
  const advance = traceAdvance(trace.slice(1).map((p, i) => along(p) - along(trace[i]!)));
  return advance === null ? null : result;
}

function closed(points: readonly FitPoint[]): boolean {
  return distance(points[0]!, points.at(-1)!) <= 0.12;
}

function circle(
  points: readonly FitPoint[],
  arc: boolean,
  trace: readonly FitPoint[],
): FitPoint[] | null {
  if (!arc && !closed(points)) return null;
  const solution = leastSquares(
    points.map((p) => [2 * p.x, 2 * p.y, 1]),
    points.map((p) => p.x * p.x + p.y * p.y),
  );
  if (!solution) return null;
  const [cx, cy, constant] = solution;
  const radius = Math.sqrt(constant! + cx! * cx! + cy! * cy!);
  if (!Number.isFinite(radius) || radius < 0.08 || radius > 3) return null;
  const angles = trace.map((p) => Math.atan2(p.y - cy!, p.x - cx!));
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

function ellipse(points: readonly FitPoint[], trace: readonly FitPoint[]): FitPoint[] | null {
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
  const sweep = angleAdvance(trace.map(angleAt));
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
    let left = Math.min(...local.map((p) => p.x)),
      right = Math.max(...local.map((p) => p.x));
    let top = Math.min(...local.map((p) => p.y)),
      bottom = Math.max(...local.map((p) => p.y));
    const current = (right - left) * (bottom - top);
    if (current >= area || Math.min(right - left, bottom - top) < 0.08) continue;
    area = current;
    // 外包极值只确定初始方向；四条边的位置由各自观测均值估计，手抖峰值不扩大矩形。
    const sides: number[][] = [[], [], [], []];
    for (const point of local) {
      const errors = [
        Math.abs(point.x - left),
        Math.abs(point.x - right),
        Math.abs(point.y - top),
        Math.abs(point.y - bottom),
      ];
      const side = errors.indexOf(Math.min(...errors));
      sides[side]!.push(side < 2 ? point.x : point.y);
    }
    if (sides.some((side) => side.length < 3)) continue;
    const bounds = sides.map((side) => side.reduce((sum, value) => sum + value, 0) / side.length);
    left = bounds[0]!;
    right = bounds[1]!;
    top = bounds[2]!;
    bottom = bounds[3]!;
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

/** 角点只提供结构候选；简单闭合边界须完整绕行一周，自交轮廓交给访问步长约束。 */
function polygonCandidate(
  contour: FitPoint[],
  trace: readonly FitPoint[],
  isClosed: boolean,
): Candidate | null {
  if (contourCrossings(contour) !== 0) return null;
  if (
    !isClosed &&
    contour.some((point, i) => contour.slice(i + 2).some((other) => distance(point, other) < 0.04))
  )
    return null;
  if (isClosed) {
    const advance = perimeterAdvance(trace, contour);
    if (advance === null || Math.abs(Math.abs(advance) - 1) > 0.4 / (2 * Math.PI)) return null;
    const area =
      Math.abs(
        contour
          .slice(1)
          .reduce((sum, point, i) => sum + contour[i]!.x * point.y - contour[i]!.y * point.x, 0),
      ) / 2;
    if (area < 0.025) return null;
  }
  const count = contour.length - 1;
  return {
    label: isClosed ? (count === 3 ? "triangle" : "polygon") : "polyline",
    points: contour,
    parameters: (contour.length - (isClosed ? 1 : 0)) * 2,
    curvedSides: isClosed,
  };
}

/** 世界坐标只在入口归一化一次，所有候选共用同一静态轮廓、顺序证据与原始观测。 */
type FitFrame = {
  source: FitPoint[];
  observed: FitPoint[];
  sampled: FitPoint[];
  trace: FitPoint[];
  radius: number;
  isClosed: boolean;
  corners: FitPoint[] | null;
  cx: number;
  cy: number;
  size: number;
  pressure: number;
};
function validPoint(point: InkPoint): boolean {
  return (
    [point.x, point.y, point.pressure].every(Number.isFinite) &&
    Math.abs(point.x) <= BOARD_COORDINATE_LIMIT &&
    Math.abs(point.y) <= BOARD_COORDINATE_LIMIT &&
    point.pressure >= 0 &&
    point.pressure <= 1
  );
}

/** 有限坐标、尺寸、缩放与观测先形成封闭输入契约；任何退化返回null。 */
function prepareFit(
  points: readonly InkPoint[],
  scale: number,
  observations?: readonly InkPoint[],
): FitFrame | null {
  if (
    points.length < 2 ||
    points.length > RECOGNITION_POINT_LIMIT ||
    !points.every(validPoint) ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    (observations &&
      (observations.length < 2 ||
        observations.length > RECOGNITION_POINT_LIMIT ||
        !observations.every(validPoint)))
  )
    return null;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  const size = Math.max(right - left, bottom - top);
  if (!Number.isFinite(size * scale) || size * scale < 16) return null;
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  const normalize = (p: InkPoint) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size });
  const source = points.map(normalize),
    observed = observations ? observations.map(normalize) : source;
  const sampled = resample(source, 192),
    radius = Math.min(HOLD_RADIUS_CSS_PX / (size * scale), 0.025);
  if (sampled.length === 0) return null;
  const trace = resample(stabilizeTrace(sampled, radius), 192);
  const isClosed = closed(sampled),
    corners = cornerContour(sampled, isClosed);
  const pressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
  return { source, observed, sampled, trace, radius, isClosed, corners, cx, cy, size, pressure };
}

/** 各族独立产生候选，结构推导不提前禁止其它有效拟合。 */
function fitCandidates(frame: FitFrame): Candidate[] {
  const { sampled, trace, isClosed, corners } = frame;
  const candidates: Candidate[] = [];
  const add = (
    label: ShapeLabel,
    fitted: FitPoint[] | null,
    parameters: number,
    curvedSides = false,
  ) => {
    if (fitted) candidates.push({ label, points: fitted, parameters, curvedSides });
  };
  add("line", line(sampled, trace), 4);
  if (isClosed) {
    // 所有几何族先独立拟合，再校验结构与残差；不让不可靠角点提前排除有效曲线。
    add("circle", circle(sampled, false, trace), 3);
    const elongated = ellipse(sampled, trace);
    if (elongated) add("ellipse", elongated, 5);
    add("rectangle", rectangle(sampled), 5);
    // 凸边界提供不受局部回描和采样往返影响的整体角点；完整原始轨迹仍验证绕行与覆盖。
    const hull = contourHull(sampled);
    if (hull.length >= 3) {
      const outline = resample([...hull, hull[0]!], 192);
      const boundary = cornerContour(outline, true);
      const supports =
        boundary &&
        (!corners ||
          corners
            .slice(0, -1)
            .every((point) =>
              boundary.slice(1).some((end, i) => segmentDistance(point, boundary[i]!, end) <= 0.04),
            ));
      if (boundary && supports) {
        const polygon = polygonCandidate(boundary, trace, true);
        if (polygon) candidates.push(polygon);
      }
    }
    if (corners) {
      const polygon = polygonCandidate(corners, trace, true);
      if (polygon) candidates.push({ ...polygon, sourceCorners: true });
      if (contourCrossings(corners) > 0) {
        const count = corners.length - 1;
        for (let step = 2; step < count / 2; step++) {
          const star = regularStar(corners, step);
          if (!star) continue;
          const sweep = angleAdvance(
            trace.map((p) => Math.atan2(p.y - star.center.y, p.x - star.center.x)),
          );
          if (sweep !== null && Math.abs(Math.abs(sweep) - step * 2 * Math.PI) <= 0.4)
            candidates.push({
              label: "star",
              points: star.points,
              parameters: 6,
              curvedSides: true,
            });
        }
      }
    }
  } else {
    add("arc", circle(sampled, true, trace), 5);
    if (corners) {
      const polyline = polygonCandidate(corners, trace, false);
      if (polyline) candidates.push(polyline);
    }
  }
  if (corners || !isClosed || angleAdvance(trace.map((p) => Math.atan2(p.y, p.x))) === null)
    add("arrow", fitArrow(sampled, trace), 7, true);
  return candidates;
}

/** 完整覆盖和原始观测先验收，再以结构和自由度选择几何；不使用训练概率。 */
function chooseCandidate(candidates: Candidate[], frame: FitFrame): Candidate | null {
  const { source, observed, radius } = frame;
  const eligible = candidates.flatMap((candidate) => {
    const error = contourDeviation(source, candidate.points);
    const maximum = candidate.curvedSides ? 0.12 : 0.075,
      rms = candidate.curvedSides ? 0.055 : 0.028;
    if (
      !error ||
      error.maximum > maximum ||
      error.rms > rms ||
      !observationsAgree(observed, candidate.points, maximum)
    )
      return [];
    return [{ ...candidate, error }];
  });
  if (eligible.length === 0) return null;
  const noise = Math.max(
    Number.EPSILON,
    radius ** 2 + Math.min(...eligible.map((candidate) => candidate.error.rms ** 2)),
  );
  // 原轨迹中集中的转向证明真实角点，边弯曲不消除这个结构证据；凸包自身不能制造角点身份。
  const straightBoundary = eligible.some(
    (candidate) =>
      (candidate.label === "polygon" || candidate.label === "triangle") &&
      (candidate.sourceCorners || candidate.error.rms <= radius),
  );
  const ranked = eligible
    .filter(
      (candidate) =>
        !straightBoundary || (candidate.label !== "circle" && candidate.label !== "ellipse"),
    )
    .map((candidate) => ({
      ...candidate,
      score: 8 * Math.log(candidate.error.rms ** 2 + noise) + candidate.parameters * Math.log(8),
    }))
    .sort((a, b) => a.score - b.score);
  // 已通过直线覆盖与往返约束时，微弯曲属于修直的范围；不能用更多参数把它留成圆弧。
  const selected = eligible.find((candidate) => candidate.label === "line") ?? ranked[0];
  if (!selected) return null;
  return selected;
}

/**
 * 直接从轨迹的闭合、局部曲率、边段、绕数与残差决定规范几何，不读取分类标签或模型分数。
 * @param points 连续笔迹的世界坐标；停笔静止观测可事先归并，但不能隐藏原始观测。
 * @param scale 屏幕缩放，用于最小尺寸和位置不确定性，不依赖画布位置或设备采样频率。
 * @param observations 归并前全部原始观测；最终逐点验证，防止把附加笔画误删成规则图形。
 * @returns 最简单的可信规范轮廓；自由曲线、退化、超界、过量回描或结构不明确返回 null。
 */
export function repairShape(
  points: readonly InkPoint[],
  scale: number,
  observations?: readonly InkPoint[],
): ShapeFit | null {
  const frame = prepareFit(points, scale, observations);
  if (!frame) return null;
  const selected = chooseCandidate(fitCandidates(frame), frame);
  if (!selected) return null;
  const result = selected.points.map((p) => ({
    x: frame.cx + p.x * frame.size,
    y: frame.cy + p.y * frame.size,
    pressure: frame.pressure,
  }));
  return result.every(validPoint) ? { label: selected.label, points: result } : null;
}
