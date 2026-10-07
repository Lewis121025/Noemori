import { straightEvidence } from "./fitting-straight-evidence";
import { convexLineContour } from "./fitting-convex-lines";
import { noiseScale, residualNoise } from "./fitting-noise";
import { fitFilletPolygons } from "./fitting-fillet";
import { fitBlockArrows } from "./fitting-block-arrow";
import { fitBranchedArrows } from "./fitting-branched-arrows";
import { fitRoundedPolygons } from "./fitting-rounded-polygon";
import { fitSymbols } from "./fitting-symbols";
import { fitSectors } from "./fitting-sectors";
import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import {
  HOLD_RADIUS_CSS_PX,
  RECOGNITION_POINT_LIMIT,
  type ShapeFit,
  type ShapeLabel,
} from "./recognition";
import { fitArrow } from "./fitting-arrow";
import { fitFreeCurve } from "./fitting-curves";
import { fitPolygonConstraints } from "./fitting-polygon-constraints";
import { fitRoundedContours } from "./fitting-rounded";
import { fitEllipseArc } from "./fitting-ellipse-arc";
import { fitFunctionalCurves } from "./fitting-functional";
import {
  circleContour,
  ellipseContour,
  fitCircleGeometry,
  fitEllipseGeometry,
} from "./fitting-conics";
import { fitLineGeometry, refinePolyline, refineRectangle } from "./fitting-lines";
import {
  cornerContour,
  contourCrossings,
  curveCornerIndices,
  credibleCornerIndices,
  regularStar,
} from "./fitting-corners";
import { stabilizeTrace } from "./stabilization";
import {
  distance,
  angleAdvance,
  contourDeviation,
  observationsAgree,
  MAX_CONTOUR_DEVIATION,
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
  /** 角点身份来自优化前的完整轮廓，优化位置不能追认原本不成立的结构证据。 */
  sourceCorners?: FitPoint[];
  /** 圆锥族用自己的精确角参数验证绕行；最近多边形投影在短轴附近可能跳边。 */
  closedTurns?: number;
};
function line(
  points: readonly FitPoint[],
  trace: readonly FitPoint[],
  uncertainty: number,
): FitPoint[] | null {
  const fit = fitLineGeometry(points, uncertainty);
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
  const noise = residualNoise(
    points.map((p) => -(p.x - fit.center.x) * dy + (p.y - fit.center.y) * dx),
  );
  const order = stabilizeTrace(
    trace,
    Math.max(uncertainty, Math.min(MAX_CONTOUR_DEVIATION, noise * 3)),
  );
  const advance = traceAdvance(order.slice(1).map((p, i) => along(p) - along(order[i]!)));
  return advance === null ? null : result;
}

function closed(points: readonly FitPoint[]): boolean {
  return distance(points[0]!, points.at(-1)!) <= 0.12;
}

/** 参数轮廓的绕行证据与渲染来自同一几何。 */
type TraversedContour = { points: FitPoint[]; closedTurns?: number };
function circle(
  points: readonly FitPoint[],
  arc: boolean,
  trace: readonly FitPoint[],
  uncertainty: number,
  observations: readonly FitPoint[],
  contour: readonly FitPoint[],
): TraversedContour | null {
  if (!arc && !closed(points)) return null;
  const fitted = fitCircleGeometry(points, uncertainty, observations, contour);
  if (!fitted) return null;
  const { x: cx, y: cy } = fitted.center;
  const radius = fitted.radius;
  if (!Number.isFinite(radius) || radius < 0.08 || radius > 3) return null;
  const angles = trace.map((p) => Math.atan2(p.y - cy, p.x - cx));
  let sweep = angleAdvance(angles);
  if (sweep === null) return null;
  if (
    arc
      ? Math.abs(sweep) < 0.4 || Math.abs(sweep) > Math.PI * 1.9
      : Math.abs(Math.abs(sweep) - Math.PI * 2) > 0.4
  )
    return null;
  const closedTurns = sweep / (2 * Math.PI);
  if (!arc) sweep = Math.sign(sweep) * Math.PI * 2;
  return { points: circleContour(fitted, angles[0]!, sweep), ...(!arc ? { closedTurns } : {}) };
}

function ellipse(
  points: readonly FitPoint[],
  trace: readonly FitPoint[],
  uncertainty: number,
  observations: readonly FitPoint[],
  contour: readonly FitPoint[],
): TraversedContour | null {
  if (!closed(points)) return null;
  const fit = fitEllipseGeometry(points, uncertainty, observations, contour);
  if (!fit) return null;
  const { x: cx, y: cy } = fit.center;
  const { major, minor, angle: rotation } = fit;
  if (![major, minor].every(Number.isFinite) || minor < 0.04 || major > 1.5) return null;
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
  return {
    points: ellipseContour(fit, start, Math.sign(sweep) * 2 * Math.PI),
    closedTurns: sweep / (2 * Math.PI),
  };
}

function rectangle(points: readonly FitPoint[], uncertainty: number): FitPoint[] | null {
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
  return result ? refineRectangle(points, result, uncertainty) : null;
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
  const isClosed = closed(sampled),
    noise = noiseScale(sampled, isClosed);
  // 轨迹顺序去抖使用实测三倍噪声尺度；全部原始观测仍约束实际图形，完整重描不能被折叠。
  const trace = resample(
      stabilizeTrace(sampled, Math.max(radius, Math.min(0.045, noise * 3))),
      192,
    ),
    corners = cornerContour(sampled, isClosed);
  const pressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
  return { source, observed, sampled, trace, radius, isClosed, corners, cx, cy, size, pressure };
}

function addPolygonCandidate(
  frame: FitFrame,
  candidates: Candidate[],
  contour: FitPoint[],
  sourceCorners: boolean,
): void {
  const { sampled, trace, isClosed, radius } = frame;
  const original = polygonCandidate(contour, trace, isClosed);
  if (!original) return;
  const refined = refinePolyline(sampled, contour, radius);
  for (const outline of refined ? [contour, refined] : [contour]) {
    const candidate = polygonCandidate(outline, trace, isClosed);
    if (candidate)
      candidates.push(
        sourceCorners && original ? { ...candidate, sourceCorners: contour } : candidate,
      );
  }
}

/** 空间简化和切线转向各自形成完整假设，合并角点集合会把噪声峰变成额外边。 */
function addCornerCandidates(frame: FitFrame, candidates: Candidate[], corners: FitPoint[]): void {
  const { sampled, trace, observed, radius } = frame;
  addPolygonCandidate(frame, candidates, corners, true);
  candidates.push(...fitBlockArrows(sampled, corners, observed, radius));
  const crossings = contourCrossings(corners);
  if (crossings === 0) {
    for (const fitted of fitPolygonConstraints(sampled, corners, radius, observed, trace))
      candidates.push({ ...fitted, curvedSides: true, sourceCorners: corners });
    return;
  }
  const count = corners.length - 1;
  for (let step = 2; step < count / 2; step++) {
    const star = regularStar(corners, step);
    if (!star) continue;
    const sweep = angleAdvance(
      trace.map((p) => Math.atan2(p.y - star.center.y, p.x - star.center.x)),
    );
    if (sweep !== null && Math.abs(Math.abs(sweep) - step * 2 * Math.PI) <= 0.4)
      candidates.push({ label: "star", points: star.points, parameters: 6, curvedSides: true });
  }
}
/** 直边候选不把包络位置当成原角点身份，所有证据仍来自完整静态输入。 */
function closedPolygons(frame: FitFrame, candidates: Candidate[]): void {
  const { sampled, isClosed, corners, radius, source } = frame;
  // 凸边界提供不受局部回描和采样往返影响的整体角点；完整原始轨迹仍验证绕行与覆盖。
  const credible = credibleCornerIndices(sampled, true).map((i) => sampled[i]!);
  const hull = contourHull(sampled);
  if (hull.length >= 3) {
    const outline = resample([...hull, hull[0]!], 192);
    const boundary = cornerContour(outline, true);
    const supportedBoundary = boundary ? refinePolyline(sampled, boundary, radius) : null;
    const supports =
      supportedBoundary &&
      credible.every((point) =>
        supportedBoundary
          .slice(1)
          .some(
            (end, i) =>
              segmentDistance(point, supportedBoundary[i]!, end) <=
              Math.max(0.04, noiseScale(sampled, true) * 3),
          ),
      );
    if (supportedBoundary && supports) {
      addPolygonCandidate(frame, candidates, supportedBoundary, false);
    }
  }
  const linearHull = convexLineContour(sampled, radius, noiseScale(sampled, true));
  if (linearHull) addPolygonCandidate(frame, candidates, linearHull, false);
  if (corners) addCornerCandidates(frame, candidates, corners);
  // 空间简化可跳过噪声谷中的接缝；原转向峰保留为独立轮廓，仍接受同一全观测校验。
  const turns = curveCornerIndices(sampled.slice(0, -1), true).map((i) => sampled[i]!);
  if (turns.length >= 3 && turns.length <= 24)
    addCornerCandidates(frame, candidates, [...turns, turns[0]!]);
  const detailCorners = cornerContour(resample(source, 384), isClosed);
  if (detailCorners && isClosed) addCornerCandidates(frame, candidates, detailCorners);
}
/** 只有尖角与每条长直边均有实测支持，才能证明C1族不适用，避免穷举阻碍停笔预览。 */
function provedLinearBoundary(candidate: Candidate | null, frame: FitFrame): boolean {
  if (
    !candidate ||
    !frame.corners ||
    frame.corners.length < 4 ||
    candidate.points.length < 4 ||
    candidate.points.length > 11
  )
    return false;
  const corners = frame.corners.slice(0, -1),
    noise = noiseScale(frame.sampled, true),
    error = contourDeviation(frame.source, candidate.points);
  if (
    !error ||
    error.rms > 0.012 ||
    corners.some(
      (p, i) => distance(p, corners[(i + 1) % corners.length]!) < Math.max(0.08, noise * 6),
    )
  )
    return false;
  const evidence = resample(frame.source, 384);
  return candidate.points
    .slice(1)
    .every((point, i) => straightEvidence(evidence, candidate.points[i]!, point));
}
/** 各族独立产生候选，结构推导不提前禁止其它有效拟合。 */
function fitCandidates(frame: FitFrame): Candidate[] {
  const { sampled, trace, isClosed, corners, radius, observed, source } = frame;
  const candidates: Candidate[] = [];
  const add = (
    label: ShapeLabel,
    fitted: FitPoint[] | null,
    parameters: number,
    curvedSides = false,
    closedTurns?: number,
  ) => {
    if (fitted)
      candidates.push({
        label,
        points: fitted,
        parameters,
        curvedSides,
        ...(closedTurns === undefined ? {} : { closedTurns }),
      });
  };
  add("line", line(sampled, trace, radius), 4);
  // 已成立的直线拥有既有优先级，提前验收避免无意义地搜索更高自由度的曲线。
  if (chooseCandidate(candidates, frame)?.label === "line") return candidates;
  add("arrow", fitArrow(sampled, trace), 7, true);
  if (chooseCandidate(candidates, frame)?.label === "arrow") return candidates;

  if (isClosed) {
    candidates.push(...fitSectors(sampled, radius), ...fitSymbols(sampled, radius));
    const rectangular = rectangle(sampled, radius);
    add("rectangle", rectangular, 5);
    closedPolygons(frame, candidates);
    if (provedLinearBoundary(chooseCandidate(candidates, frame), frame)) return candidates;
    candidates.push(
      ...fitRoundedPolygons(sampled, observed, radius),
      ...fitFilletPolygons(sampled, observed, radius),
    );
    // 未有直边与尖角的正证据时，各C1族独立拟合，不凭低质量角点提前排除。
    const circular = circle(sampled, false, trace, radius, observed, source);
    add("circle", circular?.points ?? null, 3, false, circular?.closedTurns);
    const elongated = ellipse(sampled, trace, radius, observed, source);
    if (elongated) add("ellipse", elongated.points, 5, false, elongated.closedTurns);
    if (rectangular)
      candidates.push(...fitRoundedContours(sampled, trace, observed, rectangular, radius));
  } else {
    add("arc", circle(sampled, true, trace, radius, observed, source)?.points ?? null, 5);
    add("elliptical-arc", fitEllipseArc(sampled, trace, observed, source, radius), 7);
    candidates.push(...fitFunctionalCurves(sampled, trace, observed, source, radius));
    if (corners) {
      addPolygonCandidate(frame, candidates, corners, true);
    }
  }
  if (corners || !isClosed || angleAdvance(trace.map((p) => Math.atan2(p.y, p.x))) === null)
    add("arrow", fitArrow(sampled, trace), 7, true);
  const branched = fitBranchedArrows(
    [{ index: 0, points: source, observations: observed }],
    0,
    radius,
  );
  if (branched)
    candidates.push({
      label: "arrow",
      points: branched.paths.get(0)!,
      parameters: branched.parameters,
      curvedSides: true,
    });
  return candidates;
}

/** 完整覆盖和原始观测先验收，再以结构和自由度选择几何；不使用训练概率。 */
function chooseCandidate(candidates: Candidate[], frame: FitFrame): Candidate | null {
  const { source, observed, radius, trace } = frame;
  const reliable = frame.isClosed
      ? credibleCornerIndices(frame.sampled, true).map((i) => frame.sampled[i]!)
      : [],
    positionBudget = Math.max(0.04, noiseScale(frame.sampled, frame.isClosed) * 3);
  const eligible = candidates.flatMap((candidate) => {
    // 简单闭合几何必须完整绕行一次；距离目标相同不代表两次描画可合并成一圈。
    if (
      distance(candidate.points[0]!, candidate.points.at(-1)!) < 1e-8 &&
      contourCrossings(candidate.points) === 0
    ) {
      const advance = candidate.closedTurns ?? perimeterAdvance(trace, candidate.points);
      if (advance === null || Math.abs(Math.abs(advance) - 1) > 0.4 / (2 * Math.PI)) return [];
    }
    const error = contourDeviation(source, candidate.points);
    const maximum = candidate.curvedSides ? 0.12 : MAX_CONTOUR_DEVIATION,
      rms = candidate.curvedSides ? 0.055 : 0.028;
    if (
      !error ||
      error.maximum > maximum ||
      error.rms > rms ||
      !observationsAgree(observed, candidate.points, maximum)
    )
      return [];
    const cornerSource = candidate.sourceCorners;
    const witness = cornerSource ? contourDeviation(source, cornerSource) : null;
    const cornersSupported =
      cornerSource !== undefined &&
      cornerSource
        .slice(0, -1)
        .every((point) => reliable.some((other) => distance(point, other) <= positionBudget)) &&
      witness !== null &&
      witness.maximum <= maximum &&
      witness.rms <= rms &&
      observationsAgree(observed, cornerSource, maximum);
    return [{ ...candidate, error, cornersSupported }];
  });
  if (eligible.length === 0) return null;
  const noise = Math.max(
    Number.EPSILON,
    radius ** 2 + Math.min(...eligible.map((candidate) => candidate.error.rms ** 2)),
  );
  // 固定角点窗口可能跨越密集顶点；每条边的曲率置信区间都足够窄时，完整直边也证明非光滑边界。
  const linearEvidence = frame.isClosed ? resample(source, 384) : [];
  // 集中转向或完整直边证明真实多边形；高噪声下无法排除曲率，不属于直边的正证据。
  const straightBoundary = eligible.some(
    (candidate) =>
      (candidate.label === "polygon" || candidate.label === "triangle") &&
      (candidate.cornersSupported ||
        candidate.points
          .slice(1)
          .every((point, i) =>
            straightEvidence(linearEvidence, candidate.points[i]!, point, true),
          )),
  );
  // 已验证的三分支连接是拓扑证据；自由折线不能用额外顶点的较低残差抹掉连接点身份。
  const branched = eligible.some((candidate) => candidate.label === "arrow");
  const smoothRounded =
    eligible.some((candidate) => candidate.label === "rounded-polygon") &&
    curveCornerIndices(frame.sampled.slice(0, -1), true).length === 0;
  const ranked = eligible
    .filter(
      (candidate) =>
        (!smoothRounded || (candidate.label !== "polygon" && candidate.label !== "triangle")) &&
        (!straightBoundary || (candidate.label !== "circle" && candidate.label !== "ellipse")) &&
        (!branched || candidate.label !== "polyline"),
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
 * @returns 最简单的可信规范几何或保形平滑曲线；退化、超界、过量回描或结构不明确返回 null。
 */
export function repairShape(
  points: readonly InkPoint[],
  scale: number,
  observations?: readonly InkPoint[],
): ShapeFit | null {
  const frame = prepareFit(points, scale, observations);
  if (!frame) return null;
  // 自由曲线只接续未成立的规则几何，不能用较多自由度夺走已验证的图形身份。
  const selected =
    chooseCandidate(fitCandidates(frame), frame) ??
    (() => {
      const curve = fitFreeCurve(
        frame.sampled,
        frame.source,
        frame.observed,
        frame.radius,
        Math.min(0.001, 0.25 / (frame.size * scale)),
      );
      return curve ? { label: "curve" as const, points: curve } : null;
    })();
  if (!selected) return null;
  const result = selected.points.map((p) => ({
    x: frame.cx + p.x * frame.size,
    y: frame.cy + p.y * frame.size,
    pressure: frame.pressure,
  }));
  if (
    selected.label === "curve" &&
    distance(selected.points[0]!, selected.points.at(-1)!) > 1e-10
  ) {
    // 开放样条的固定端点复用原世界坐标，归一化往返不能引入浮点漂移。
    result[0] = { x: points[0]!.x, y: points[0]!.y, pressure: frame.pressure };
    result[result.length - 1] = {
      x: points.at(-1)!.x,
      y: points.at(-1)!.y,
      pressure: frame.pressure,
    };
  }
  return result.every(validPoint) ? { label: selected.label, points: result } : null;
}
