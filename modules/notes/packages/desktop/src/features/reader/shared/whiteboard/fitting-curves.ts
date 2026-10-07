import { curveCornerIndices } from "./fitting-corners";
import { curveStructure, curveStructureAgrees } from "./fitting-curve-structure";
import {
  contourDeviation,
  distance,
  observationsAgree,
  MAX_CONTOUR_DEVIATION,
  type FitPoint,
} from "./fitting-math";
import { solveSpline, splineContour, splinePoint, type CubicSpline } from "./fitting-spline";

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** 二次Savitzky–Golay导向只估计参数和噪声，真实采样仍参与求解与最大误差验收。 */
function pilotContour(points: readonly FitPoint[], periodic: boolean, halfWindow = 4): FitPoint[] {
  const denominator = (2 * halfWindow + 3) * (2 * halfWindow + 1) * (2 * halfWindow - 1),
    weights = Array.from(
      { length: 2 * halfWindow + 1 },
      (_, i) =>
        (3 * (3 * halfWindow ** 2 + 3 * halfWindow - 1 - 5 * (i - halfWindow) ** 2)) / denominator,
    );
  const at = (index: number): FitPoint => {
    if (periodic) return points[(index + points.length) % points.length]!;
    if (index < 0)
      return { x: 2 * points[0]!.x - points[-index]!.x, y: 2 * points[0]!.y - points[-index]!.y };
    if (index >= points.length) {
      const mirrored = points[2 * (points.length - 1) - index]!,
        last = points.at(-1)!;
      return { x: 2 * last.x - mirrored.x, y: 2 * last.y - mirrored.y };
    }
    return points[index]!;
  };
  return points.map((_, i) =>
    weights.reduce(
      (sum, weight, j) => {
        const point = at(i + j - halfWindow);
        return { x: sum.x + weight * point.x, y: sum.y + weight * point.y };
      },
      { x: 0, y: 0 },
    ),
  );
}

function parameterize(points: readonly FitPoint[], periodic: boolean): number[] | null {
  const lengths = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(lengths.at(-1)! + distance(points[i - 1]!, points[i]!));
  const total = lengths.at(-1)! + (periodic ? distance(points.at(-1)!, points[0]!) : 0);
  if (total <= 1e-8 || lengths.some((t, i) => i > 0 && t <= lengths[i - 1]!)) return null;
  return lengths.map((value) => value / total);
}

function noiseScale(points: readonly FitPoint[], periodic: boolean): number {
  // 估噪窗口宽于参数导向窗口，避免相关性抖动被导向本身跟随后低估噪声。
  const halfWindow = Math.min(8, Math.floor((points.length - 1) / 4)),
    pilot = pilotContour(points, periodic, halfWindow),
    centralWeight =
      (3 * (3 * halfWindow ** 2 + 3 * halfWindow - 1)) /
      ((2 * halfWindow + 3) * (2 * halfWindow + 1) * (2 * halfWindow - 1));
  const residuals = points.flatMap((point, i) => {
    if (!periodic && (i < halfWindow || i >= points.length - halfWindow)) return [];
    const before = pilot[(i - 1 + pilot.length) % pilot.length]!,
      after = pilot[(i + 1) % pilot.length]!,
      length = distance(before, after);
    return length > 1e-8
      ? [
          Math.abs(
            (point.x - pilot[i]!.x) * (after.y - before.y) -
              (point.y - pilot[i]!.y) * (after.x - before.x),
          ) / length,
        ]
      : [];
  });
  // 正态绝对残差的中位数恢复尺度，并补偿SG滤波中心权重；孤立尖角不抬高整条曲线噪声预算。
  return residuals.length ? (median(residuals) * 1.4826) / Math.sqrt(1 - centralWeight) : 0;
}

/** 局部最近点Newton迭代受相邻参数中点限制，不允许在自交处跳到另一条分支。 */
function refineParameters(
  points: readonly FitPoint[],
  parameters: readonly number[],
  spline: CubicSpline,
): number[] {
  return parameters.map((parameter, i) => {
    if (i === 0 || i === points.length - 1) return parameter;
    // 保留相邻参数间隙，双方同时投影到中点也不能使严格顺序退化成重复参数。
    const lower = parameter - (parameter - parameters[i - 1]!) * 0.49,
      upper = parameter + (parameters[i + 1]! - parameter) * 0.49;
    let at = parameter;
    for (let step = 0; step < 4; step++) {
      const point = splinePoint(spline, at),
        tangent = splinePoint(spline, at, 1),
        acceleration = splinePoint(spline, at, 2),
        dx = point.x - points[i]!.x,
        dy = point.y - points[i]!.y,
        curvature = tangent.x ** 2 + tangent.y ** 2 + dx * acceleration.x + dy * acceleration.y;
      if (curvature <= 1e-10) break;
      const candidate = Math.max(
        lower,
        Math.min(upper, at - (dx * tangent.x + dy * tangent.y) / curvature),
      );
      if (distance(splinePoint(spline, candidate), points[i]!) >= distance(point, points[i]!))
        break;
      at = candidate;
    }
    return at;
  });
}

function fitSection(
  points: readonly FitPoint[],
  periodic: boolean,
  uncertainty: number,
): CubicSpline | null {
  if (points.length < 9) return null;
  const pilot = pilotContour(points, periodic),
    initialParameters = parameterize(pilot, periodic);
  if (!initialParameters) return null;
  const noise = noiseScale(points, periodic),
    budget = Math.min(0.022, Math.max(0.0004, uncertainty * 0.12, noise * 1.05)),
    cutoff = 1.345 * Math.max(noise, uncertainty * 0.12, 0.0004);
  const error = (spline: CubicSpline, parameters: readonly number[]) =>
    Math.sqrt(
      points.reduce(
        (sum, p, i) =>
          sum + Math.min(distance(p, splinePoint(spline, parameters[i]!)), cutoff * 2.5) ** 2,
        0,
      ) / points.length,
    );
  let fitted: CubicSpline | null = null,
    parameters = initialParameters,
    count = 0;
  // 自适应增加自由度直至能表达宏观轮廓；不靠增加控制点追逐全部原始抖动。
  for (const controls of [12, 24, 48]) {
    count = Math.min(controls, points.length - 1);
    let candidate = solveSpline(points, parameters, count, periodic, 1e-12, cutoff);
    if (!candidate) continue;
    for (let step = 0; step < 2; step++) {
      parameters = refineParameters(points, parameters, candidate);
      candidate = solveSpline(points, parameters, count, periodic, 1e-12, cutoff);
      if (!candidate) break;
    }
    if (!candidate) continue;
    fitted = candidate;
    if (error(candidate, parameters) <= budget) break;
  }
  if (!fitted) return null;
  const minimum = error(fitted, parameters);
  if (minimum > Math.max(budget * 1.5, 0.006)) return null;
  const allowance = Math.max(budget, minimum * 1.02);
  let lower = 1e-12,
    upper = 1e-3;
  for (let penalty = 1e-9; penalty <= 1e-3; penalty *= 10) {
    const candidate = solveSpline(points, parameters, count, periodic, penalty, cutoff);
    if (!candidate || error(candidate, parameters) > allowance) {
      upper = penalty;
      break;
    }
    lower = penalty;
    fitted = candidate;
  }
  // 差异原则选择误差预算内最强平滑；对数搜索不让设备像素密度成为任意平滑参数。
  for (let step = 0; step < 5 && upper > lower * 1.1; step++) {
    const penalty = Math.sqrt(lower * upper),
      candidate = solveSpline(points, parameters, count, periodic, penalty, cutoff);
    if (!candidate || error(candidate, parameters) > allowance) upper = penalty;
    else {
      lower = penalty;
      fitted = candidate;
    }
  }
  for (let step = 0; step < 2; step++) {
    const refined = refineParameters(points, parameters, fitted),
      candidate = solveSpline(points, refined, count, periodic, lower, cutoff);
    if (!candidate || error(candidate, refined) > allowance) break;
    parameters = refined;
    fitted = candidate;
  }
  return fitted;
}

function fitSections(
  points: FitPoint[],
  periodic: boolean,
  uncertainty: number,
  tolerance: number,
): FitPoint[] | null {
  const corners = curveCornerIndices(pilotContour(points, periodic), periodic);
  if (corners.length === 0) {
    const fit = fitSection(points, periodic, uncertainty);
    return fit ? splineContour(fit, tolerance) : null;
  }
  // 闭合尖角轮廓从真实角点分段，接缝随后恢复到原起笔附近；平滑闭合曲线使用周期基函数。
  const offset = periodic ? corners[0]! : 0,
    source = periodic
      ? [...points.slice(offset), ...points.slice(0, offset), points[offset]!]
      : points,
    indices = periodic
      ? corners
          .map((index) => (index - offset + points.length) % points.length)
          .sort((a, b) => a - b)
      : corners;
  const breaks = [...new Set([0, ...indices, source.length - 1])],
    result: FitPoint[] = [];
  for (let i = 1; i < breaks.length; i++) {
    const section = source.slice(breaks[i - 1]!, breaks[i]! + 1),
      fitted = fitSection(section, false, uncertainty),
      contour = fitted ? splineContour(fitted, tolerance) : null;
    if (!contour) return null;
    result.push(...contour.slice(i === 1 ? 0 : 1));
    if (result.length > 4096) return null;
  }
  if (periodic) {
    const index = result
      .slice(0, -1)
      .reduce(
        (best, p, i) => (distance(p, points[0]!) < distance(result[best]!, points[0]!) ? i : best),
        0,
      );
    return [...result.slice(index, -1), ...result.slice(0, index + 1)];
  }
  return result;
}

/**
 * 鲁棒参数三次平滑B样条：自适应自由度、精确弯曲惩罚、顺序重参数化与差异原则共同抑制抖动。
 * @param sampled 192个等弧长有限归一化点；规则几何候选已优先完成验收。
 * @param source 完整静态轨迹，只用于最终轮廓覆盖及拓扑验收。
 * @param observations 未删减的原始观测，静止采样密度不进入拟合目标。
 * @param uncertainty 停笔位置的不确定性，使用同一屏幕缩放归一化。
 * @param tolerance 实际渲染点列的正有限弦误差预算。
 * @returns 通过误差和有序结构验收的开放或闭合点列；退化、过量回访或不可保形时返回null。
 * @throws 底层数值异常向上传播，不能把求解失败伪装成正常拒绝。
 */
export function fitFreeCurve(
  sampled: readonly FitPoint[],
  source: readonly FitPoint[],
  observations: readonly FitPoint[],
  uncertainty: number,
  tolerance: number,
): FitPoint[] | null {
  // 任意曲线缺少明确的补口几何约束，仅亚像素接缝视为闭合，不能把可见开口自动封住。
  const periodic =
      distance(sampled[0]!, sampled.at(-1)!) <= Math.max(1e-8, Math.min(uncertainty * 0.1, 0.001)),
    points = periodic ? sampled.slice(0, -1) : [...sampled],
    resolution = tolerance,
    // 打结预算只能来自实测噪声；停笔半径不是自由曲线细节的删除许可。
    noiseAllowance = Math.min(0.03, noiseScale(points, periodic) * 6),
    expected = curveStructure(source, resolution, noiseAllowance);
  if (!expected) return null;
  const result = fitSections(points, periodic, uncertainty, tolerance);
  if (!result) return null;
  const error = contourDeviation(source, result),
    actual = curveStructure(result, resolution, noiseAllowance);
  return error &&
    error.maximum <= MAX_CONTOUR_DEVIATION &&
    error.rms <= 0.028 &&
    observationsAgree(observations, result) &&
    actual &&
    curveStructureAgrees(expected, actual)
    ? result
    : null;
}
