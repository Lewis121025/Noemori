import { noiseScale, pilotContour } from "./fitting-noise";
import { distance, leastSquares, type FitPoint } from "./fitting-math";
import { stabilizeTrace } from "./stabilization";

/** 单侧二次回归的固定设计只计算一次；左右切线外推不能跨尖角混合采样。 */
function tangentWeights(span: number): number[][] {
  const design = Array.from({ length: span }, (_, i) => [1, (i + 1) / span, ((i + 1) / span) ** 2]);
  return Array.from({ length: 3 }, (_, component) =>
    design.map(
      (_, row) =>
        leastSquares(
          design,
          design.map((_, i) => (i === row ? 1 : 0)),
        )![component]!,
    ),
  );
}
const TANGENT_WEIGHTS = new Map([6, 12, 24].map((span) => [span, tangentWeights(span)]));

/** C1轮廓两侧外推切线一致；真正尖角的方向跳变应超过拟合噪声的置信范围。 */
function tangentDiscontinuity(
  points: readonly FitPoint[],
  at: number,
  closed: boolean,
  span: number,
  noiseFloor = 0,
): { turn: number; uncertainty: number } {
  const weights = TANGENT_WEIGHTS.get(span)!;
  const side = (direction: number) => {
    const source = Array.from({ length: span }, (_, i) => {
      const index = at + direction * (i + 1);
      return points[
        closed
          ? (index + points.length) % points.length
          : Math.max(0, Math.min(points.length - 1, index))
      ]!;
    });
    const coefficients = weights.map((row) => ({
      x: row.reduce((sum, w, i) => sum + w * source[i]!.x, 0),
      y: row.reduce((sum, w, i) => sum + w * source[i]!.y, 0),
    }));
    const velocity = { x: coefficients[1]!.x * direction, y: coefficients[1]!.y * direction };
    const residual = source.reduce((sum, p, i) => {
      const t = (i + 1) / span;
      return (
        sum +
        (p.x - coefficients[0]!.x - coefficients[1]!.x * t - coefficients[2]!.x * t * t) ** 2 +
        (p.y - coefficients[0]!.y - coefficients[1]!.y * t - coefficients[2]!.y * t * t) ** 2
      );
    }, 0);
    const variance = Math.max(residual / (2 * (span - 3)), noiseFloor ** 2),
      factor = weights[1]!.reduce((sum, w) => sum + w * w, 0),
      length = Math.hypot(velocity.x, velocity.y);
    return {
      angle: Math.atan2(velocity.y, velocity.x),
      uncertainty: length > 1e-10 ? Math.sqrt(variance * factor) / length : Infinity,
    };
  };
  const left = side(-1),
    right = side(1),
    delta = right.angle - left.angle;
  return {
    turn: Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))),
    uncertainty: Math.hypot(left.uncertainty, right.uncertainty),
  };
}

/** 角点必须是局部集中的转向；圆弧上均匀分布的曲率不能被折线简化制造成角点。 */
function turnEvidence(
  points: readonly FitPoint[],
  at: number,
  closed: boolean,
  continuous = false,
  noiseFloor = 0,
): { turn: number; localized: boolean; confident: boolean } {
  const sample = (offset: number) => {
    const index = closed
      ? (at + offset + points.length) % points.length
      : Math.max(0, Math.min(points.length - 1, at + offset));
    return points[index]!;
  };
  // 用邻域均值估计切向，避免单个抖动峰值改变角点的转向身份；原始点仍用于最终校验。
  const point = (offset: number) => {
    const neighborhood = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((i) => sample(offset + i));
    return {
      x: neighborhood.reduce((sum, p) => sum + p.x, 0) / neighborhood.length,
      y: neighborhood.reduce((sum, p) => sum + p.y, 0) / neighborhood.length,
    };
  };
  const turn = (span: number) => {
    const a = point(-span),
      b = point(0),
      c = point(span);
    const first = Math.atan2(b.y - a.y, b.x - a.x);
    const second = Math.atan2(c.y - b.y, c.x - b.x);
    return Math.abs(Math.atan2(Math.sin(second - first), Math.cos(second - first)));
  };
  const local = turn(6),
    overall = turn(16);
  const fine = tangentDiscontinuity(points, at, closed, 6, noiseFloor),
    coarse = tangentDiscontinuity(points, at, closed, 12, noiseFloor),
    wide = tangentDiscontinuity(points, at, closed, 24, noiseFloor);
  const agrees = (a: typeof fine, b: typeof fine) =>
    a.turn - 2.5 * a.uncertainty > 0.16 &&
    b.turn - 2.5 * b.uncertainty > 0.16 &&
    Math.abs(a.turn - b.turn) < 0.28;
  const fineSupported = agrees(fine, coarse),
    coarseSupported =
      agrees(coarse, wide) &&
      Math.abs(fine.turn - coarse.turn) <=
        2.5 * Math.hypot(fine.uncertainty, coarse.uncertainty) + 0.08,
    confident = fineSupported || coarseSupported;
  // 强抖动下细窗口的切线未收敛，不能否决在两个更宽尺度上稳定成立的真实转向。
  const supportedTurn = fineSupported ? fine.turn : coarse.turn;
  const noisy = fine.uncertainty > 0.3 && local > 0.9 && local >= overall * 0.55;
  return {
    turn: continuous && confident ? supportedTurn : continuous && noisy ? fine.turn : local,
    confident,
    localized:
      local >= 0.38 &&
      local < Math.PI - 0.08 &&
      local >= overall * 0.55 &&
      (!continuous || confident || noisy),
  };
}

/**
 * 提取自由曲线中的集中尖角，持续曲率不作为分段依据；不要求固定角点数量。
 * @param points 192个等弧长有限采样，闭合时不含重复末点。
 * @param closed 是否按周期邻域评价接缝。
 * @returns 按原顺序的尖角索引；平滑轮廓返回空数组，不抛异常。
 */
export function curveCornerIndices(points: readonly FitPoint[], closed: boolean): number[] {
  const guide = pilotContour(points, closed),
    support = guide.map((_, i) => turnEvidence(guide, i, closed)),
    noisy = noiseScale(points, closed) > 0.001;
  const evidence = points.map((_, i) => turnEvidence(points, i, closed, true));
  const candidates = evidence.flatMap((entry, i) =>
    entry.localized &&
    (!noisy || support[i]!.localized) &&
    entry.turn >= 0.7 &&
    (closed || (i >= 8 && i < points.length - 8))
      ? [i]
      : [],
  );
  const kept: number[] = [];
  for (const index of candidates.sort((a, b) => evidence[b]!.turn - evidence[a]!.turn)) {
    if (
      !kept.some((other) => {
        const span = Math.abs(index - other);
        return (closed ? Math.min(span, points.length - span) : span) <= 10;
      })
    )
      kept.push(index);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * 只返回两侧切线跳变置信区间成立的角点，用于否决凸边界候选；不确定的噪声峰不属于反证。
 * @param points 等弧长有限采样。
 * @param closed 是否使用周期邻域。
 * @returns 有可靠切线不连续证据的原索引；不抛异常。
 */
export function credibleCornerIndices(points: readonly FitPoint[], closed: boolean): number[] {
  const noise = noiseScale(points, closed);
  // 相关抖动可在小窗口内近似二次式，局部残差不能低于整条轮廓的实测噪声。
  return points.flatMap((_, i) => {
    const evidence = turnEvidence(points, i, closed, true, noise);
    return evidence.localized && evidence.confident ? [i] : [];
  });
}

/**
 * 提取任意边数轮廓的稳定角点，不使用图形类别、模型分数或屏幕像素位置。
 * @param points 等弧长的有限归一化点；调用方限制为192点。
 * @param closed 是否具有可补齐的小闭合缺口。
 * @returns 原顺序角点；平滑曲线、过短边段或过多角点返回 null，不抛异常。
 */
export function cornerContour(points: readonly FitPoint[], closed: boolean): FitPoint[] | null {
  const source =
    closed && distance(points[0]!, points.at(-1)!) < 1e-6 ? points.slice(0, -1) : points;
  const loop = closed ? [...source, source[0]!] : [...source];
  const simplified = stabilizeTrace(loop, 0.04);
  const evidence = source.map((_, i) => turnEvidence(source, i, closed, true));
  const peaks = new Set<number>();
  for (const point of simplified.slice(0, closed ? -1 : undefined)) {
    const seed = source.indexOf(point);
    if (!closed && (seed === 0 || seed === source.length - 1)) {
      peaks.add(seed);
      continue;
    }
    let peak = seed;
    // 简化点可能选中噪声的空间极值；在同一邻域寻找转向峰，不把空间极值当真实角点。
    for (let delta = -6; delta <= 6; delta++) {
      const index = closed
        ? (seed + delta + source.length) % source.length
        : Math.max(0, Math.min(source.length - 1, seed + delta));
      if (evidence[index]!.turn > evidence[peak]!.turn) peak = index;
    }
    if (evidence[peak]!.localized) peaks.add(peak);
  }
  const separation = (a: number, b: number) =>
    closed ? Math.min(Math.abs(a - b), source.length - Math.abs(a - b)) : Math.abs(a - b);
  const kept: number[] = [];
  for (const index of [...peaks].sort((a, b) => evidence[b]!.turn - evidence[a]!.turn)) {
    if (!kept.some((other) => separation(index, other) <= 8)) kept.push(index);
  }
  const visited = kept.sort((a, b) => a - b).map((index) => source[index]!);
  // 角点是空间实体，同一角点的局部回访不增加边数；完整重描仍由有序推进校验拒绝。
  const vertices = closed
    ? visited.filter(
        (point, i) => visited.findIndex((other) => distance(point, other) <= 0.04) === i,
      )
    : visited;
  if (vertices.length < 3 || vertices.length > 24) return null;
  const contour = closed ? [...vertices, vertices[0]!] : vertices;
  if (contour.slice(1).some((point, i) => distance(point, contour[i]!) < 0.04)) return null;
  return contour;
}

/** 非相邻边的严格交叉数；端点接触不制造自交身份，零长度边由调用方拒绝。 */
export function contourCrossings(points: readonly FitPoint[]): number {
  const side = (a: FitPoint, b: FitPoint, p: FitPoint) =>
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    for (let j = i + 2; j < points.length; j++) {
      if (i === 1 && j === points.length - 1) continue;
      const a = points[i - 1]!,
        b = points[i]!,
        c = points[j - 1]!,
        d = points[j]!;
      if (side(a, b, c) * side(a, b, d) < -1e-10 && side(c, d, a) * side(c, d, b) < -1e-10) count++;
    }
  }
  return count;
}

/**
 * 由等角顶点的访问步长拟合星形；同一方程覆盖不同顶点数、方向及长宽比例。
 * @param contour 按绘制顺序的闭合角点，最后一点与第一点相同。
 * @param step 顶点环上的访问步长；必须遍历全部顶点而非重复某个子环。
 * @returns 仿射规范星形及中心；病态变换、重复子环或拓扑不符返回 null。
 */
export function regularStar(
  contour: readonly FitPoint[],
  step: number,
): { points: FitPoint[]; center: FitPoint } | null {
  const vertices = contour.slice(0, -1),
    count = vertices.length;
  if (count < 5 || new Set(vertices.map((_, i) => (i * step) % count)).size !== count) return null;
  const rows = vertices.map((_, i) => {
    const angle = (i * step * 2 * Math.PI) / count;
    return [1, Math.cos(angle), Math.sin(angle)];
  });
  const x = leastSquares(
    rows,
    vertices.map((point) => point.x),
  );
  const y = leastSquares(
    rows,
    vertices.map((point) => point.y),
  );
  if (!x || !y) return null;
  const determinant = x[1]! * y[2]! - x[2]! * y[1]!;
  const squared = x[1]! ** 2 + x[2]! ** 2 + y[1]! ** 2 + y[2]! ** 2;
  if (Math.abs(determinant) < 0.01 || squared / Math.abs(determinant) > 4) return null;
  const fitted = rows.map((row) => ({
    x: row.reduce((sum, value, i) => sum + value * x[i]!, 0),
    y: row.reduce((sum, value, i) => sum + value * y[i]!, 0),
  }));
  fitted.push(fitted[0]!);
  if (contourCrossings(fitted) !== contourCrossings(contour)) return null;
  return { points: fitted, center: { x: x[0]!, y: y[0]! } };
}
