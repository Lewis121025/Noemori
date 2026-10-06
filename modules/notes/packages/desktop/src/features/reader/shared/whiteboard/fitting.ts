import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import {
  HOLD_RADIUS_CSS_PX,
  RECOGNITION_POINT_LIMIT,
  type ShapeLabel,
  type ShapePrediction,
  type ShapeCandidate,
  type OvalEvidence,
} from "./recognition";
import { fitArrow } from "./fitting-arrow";
import { stabilizeTrace } from "./stabilization";
import {
  distance,
  angleAdvance,
  contourHull,
  fitAgrees,
  contourDeviation,
  observationsAgree,
  leastSquares,
  principalLine,
  perimeterAdvance,
  resample,
  traceAdvance,
  type FitPoint,
} from "./fitting-math";

/** 单路径验证集上的联合门槛；多数模型候选还必须通过完整几何约束与双向轮廓检查。 */
const MIN_SHAPE_SCORE = 0.5;

/** 已验证的规范轮廓及最终几何类型；模型标签只选择拟合族，不能替代轮廓证据。 */
export type ShapeFit = { label: Exclude<ShapeLabel, "other">; points: InkPoint[] };

/** 拟合候选仍使用无量纲坐标，全部候选共用同一覆盖与原始观测校验。 */
type NormalizedShapeFit = { label: ShapeFit["label"]; points: FitPoint[] };

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

function ellipse(
  points: readonly FitPoint[],
  trace: readonly FitPoint[],
): { points: FitPoint[]; axisDifference: number } | null {
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
  return { points: result, axisDifference: major - minor };
}

function oval(
  points: readonly FitPoint[],
  trace: readonly FitPoint[],
  radius: number,
  preferred: "circle" | "ellipse",
  evidence?: OvalEvidence,
  source: readonly FitPoint[] = points,
  observations?: readonly FitPoint[],
): NormalizedShapeFit[] {
  const round = circle(points, false, trace);
  const elongated = ellipse(points, trace);
  const candidates: NormalizedShapeFit[] = [];
  if (round) candidates.push({ label: "circle", points: round });
  if (elongated) candidates.push({ label: "ellipse", points: elongated.points });
  const agrees = (fitted: readonly FitPoint[]) =>
    fitAgrees(source, fitted) && (!observations || observationsAgree(observations, fitted));
  const roundAgrees = round !== null && agrees(round);
  if (preferred === "circle" && roundAgrees)
    return candidates.filter((candidate) => candidate.label === "circle");
  if (!evidence) return candidates.filter((candidate) => candidate.label === preferred);
  // 模型与有效椭圆一致时，未通过完整校验的圆不能阻断原来正确的修复。
  if (preferred === "ellipse" && elongated && agrees(elongated.points) && !roundAgrees)
    return candidates.filter((candidate) => candidate.label === "ellipse");
  // 长短轴差落在两轴的位置不确定性内时，圆是同一几何的更简单表示。
  if (elongated && elongated.axisDifference <= 2 * radius && roundAgrees)
    return candidates.filter((candidate) => candidate.label === "circle");
  // 以8个有效整体观测的启发式惩罚比较3参数圆与5参数椭圆，不把192个相关点当独立观测。
  // 误差以既有位置不确定性为底噪；更多自由度或仅略小的残差不足以推翻强模型先验。
  const score = (candidate: NormalizedShapeFit) => {
    const error = contourDeviation(source, candidate.points);
    if (!error) return Infinity;
    const label = candidate.label === "circle" ? "circle" : "ellipse";
    const parameters = label === "circle" ? 3 : 5;
    return (
      8 * Math.log(error.rms ** 2 + radius ** 2) +
      parameters * Math.log(8) -
      2 * Math.log(Math.max(evidence[label], 1e-12))
    );
  };
  // 备选子类型须占圆/椭圆合计概率至少20%，不让几何推翻模型几乎排除的类型。
  const mass = evidence.circle + evidence.ellipse;
  const credible = candidates.filter(
    (candidate) =>
      candidate.label === preferred ||
      evidence[candidate.label === "circle" ? "circle" : "ellipse"] / mass >= 0.2,
  );
  const ordered = credible.sort((a, b) => score(a) - score(b));
  // 几何校验失败时保留笔迹；不能靠逐个尝试把拒绝的强圆先验悄悄变成椭圆。
  return ordered.slice(0, 1);
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

function triangle(points: readonly FitPoint[], trace: readonly FitPoint[]): FitPoint[] | null {
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
  const advance = perimeterAdvance(trace, result);
  return advance === null || Math.abs(Math.abs(advance) - 1) > 0.4 / (2 * Math.PI) ? null : result;
}

/**
 * 分类提供拟合族和形状先验；圆与椭圆共享闭合曲线族，最终类型须符合静态整体轮廓。
 * @param points 一个连续笔迹的已校验世界坐标，可归并已确认静止的末点观测。
 * @param prediction 静态模型候选；分数仅作入口门槛，不能代替几何证据。
 * @param scale 屏幕缩放，用于最小尺寸与有界顺序去抖半径。
 * @param observations 归并前的全部原始观测；逐点验证既有最大偏差，防止隐藏额外笔画。
 * @returns 最终几何类型和可存入原有笔迹格式的规范轮廓；低置信度、退化或校验失败返回 null。
 */
export function fitShape(
  points: readonly InkPoint[],
  prediction: ShapePrediction,
  scale: number,
  observations?: readonly InkPoint[],
): ShapeFit | null {
  const refinement = prediction.refinement;
  // 单头模型缺少第二份子类型证据，保留直接标签；合计概率只解决族内分票。
  const original = fitCandidate(points, prediction, scale, observations, !refinement);
  if (!refinement) return original;
  const supported = (candidate: ShapeCandidate, label: ShapeLabel) =>
    candidate.label === label ||
    ((label === "circle" || label === "ellipse") &&
      candidate.oval &&
      candidate.oval[label] / (candidate.oval.circle + candidate.oval.ellipse) >= 0.2);
  if (original) {
    // 合计概率只能证明拟合族；原单类未准入时，新增子类型须由至少一个头明确选中。
    if (original.label === prediction.label) return original;
    if (
      supported(refinement, original.label) &&
      (prediction.confidence >= MIN_SHAPE_SCORE || refinement.label === original.label)
    )
      return original;
    // 跨子类型修复须同时符合两头证据；原模型直接类型的有效拟合始终保留。
    return fitCandidate(points, prediction, scale, observations, true);
  }
  // 原模型明确拒绝未知输入时，较弱的改进候选不足以推翻该拒绝。
  if (
    prediction.label === "other" &&
    prediction.confidence >= MIN_SHAPE_SCORE &&
    refinement.confidence <= prediction.confidence
  )
    return null;
  const family = (label: ShapeLabel) =>
    label === "circle" || label === "ellipse" ? "oval" : label;
  // 原候选已完成族概率准入与全部几何判定；相关的新头不能靠加分重试同族拒绝。
  if (family(prediction.label) === family(refinement.label)) return null;
  const refined = fitCandidate(points, refinement, scale, observations);
  // 新修复的最终类型须至少被一个头选中；两个头均未确认的子类型应保留自由笔迹。
  return refined && (refined.label === prediction.label || refined.label === refinement.label)
    ? refined
    : null;
}

/** 每个候选独立通过原有入口、覆盖和完整观测校验；改进头不能绕过任何几何门槛。 */
function fitCandidate(
  points: readonly InkPoint[],
  prediction: ShapeCandidate,
  scale: number,
  observations?: readonly InkPoint[],
  predictedSubtypeOnly = false,
): ShapeFit | null {
  const familyConfidence = prediction.oval
    ? prediction.oval.circle + prediction.oval.ellipse
    : prediction.confidence;
  if (
    points.length < 2 ||
    points.length > RECOGNITION_POINT_LIMIT ||
    (observations !== undefined &&
      (observations.length < 2 || observations.length > RECOGNITION_POINT_LIMIT)) ||
    prediction.label === "other" ||
    !Number.isFinite(prediction.confidence) ||
    !Number.isFinite(familyConfidence) ||
    familyConfidence < MIN_SHAPE_SCORE ||
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
  // 参数估计保留移动轨迹的统计信息；仅顺序校验使用有界去抖，最终验证仍覆盖完整几何。
  // 顺序去抖限制为3 CSS像素和尺寸的2.5%，停笔观测归并由输入状态机独立负责。
  const radius = Math.min(HOLD_RADIUS_CSS_PX / (size * scale), 0.025);
  const sampled = resample(normalized, 192);
  const trace = resample(stabilizeTrace(sampled, radius), 192);
  if (sampled.length === 0) return null;
  const fitters = {
    line,
    arc: (p: readonly FitPoint[], t: readonly FitPoint[]) => circle(p, true, t),
    rectangle,
    triangle,
    arrow: fitArrow,
  };
  const observed = observations?.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }));
  let candidates: NormalizedShapeFit[];
  if (prediction.label === "circle" || prediction.label === "ellipse") {
    candidates = predictedSubtypeOnly
      ? oval(sampled, trace, radius, prediction.label, undefined, normalized, observed)
      : oval(sampled, trace, radius, prediction.label, prediction.oval, normalized, observed);
  } else {
    const points = fitters[prediction.label](sampled, trace);
    candidates = points ? [{ label: prediction.label, points }] : [];
  }
  const fitted = candidates.find(
    (candidate) =>
      fitAgrees(normalized, candidate.points) &&
      (!observed || observationsAgree(observed, candidate.points)),
  );
  if (!fitted) return null;
  const pressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
  const result = fitted.points.map((p) => ({ x: cx + p.x * size, y: cy + p.y * size, pressure }));
  return result.every(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Math.abs(p.x) <= BOARD_COORDINATE_LIMIT &&
      Math.abs(p.y) <= BOARD_COORDINATE_LIMIT,
  )
    ? { label: fitted.label, points: result }
    : null;
}
