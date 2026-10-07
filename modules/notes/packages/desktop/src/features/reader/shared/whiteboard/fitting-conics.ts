import { EigenvalueDecomposition, Matrix, SingularValueDecomposition } from "ml-matrix";
import { distance, leastSquares, MAX_CONTOUR_DEVIATION, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";
import { renderedCoverage, type Coverage } from "./fitting-coverage";

/** 圆与椭圆的整圈段数，渲染点列和弦高预算必须共用同一分辨率。 */
export const CONIC_SEGMENTS = 128;
/** 整圈的弦高上界；仿射椭圆再乘长半轴，保证点列与解析曲线共用偏差契约。 */
const CHORD_DEVIATION = 1 - Math.cos(Math.PI / CONIC_SEGMENTS);

/** 圆的几何参数；圆弧共用中心与半径，扫角由完整有序轨迹决定。 */
export type CircleGeometry = { center: FitPoint; radius: number };
/** 椭圆的几何参数；major≥minor>0，angle为长轴在世界坐标中的弧度方向。 */
export type EllipseGeometry = { center: FitPoint; major: number; minor: number; angle: number };

/** 同一圆锥曲线的统计目标、真实观测与渲染轮廓，约束生成不得改变采样权重。 */
type ConicProblem = {
  initial: number[];
  evaluate: (p: readonly number[]) => Coverage | null;
  render: (p: readonly number[]) => FitPoint[] | null;
  contour: readonly FitPoint[];
  measured: readonly FitPoint[];
  count: number;
  uncertainty: number;
  approximation: (p: readonly number[]) => { margin: number; gradient: number[] };
};

/** 先解逐点约束，仅在反向覆盖违反时生成双向约束，避免所有拒绝图形都进行昂贵ICP搜索。 */
function optimizeConic(problem: ConicProblem): number[] | null {
  const { initial, evaluate, render, contour, measured, count, uncertainty, approximation } =
    problem;
  const fitted = optimizeGeometry(
    initial,
    (p) => evaluate(p)?.errors ?? null,
    uncertainty,
    MAX_CONTOUR_DEVIATION,
    (p) => evaluate(p)?.jacobian ?? null,
    approximation,
    count,
  );
  if (!fitted) return null;
  const pointwise = evaluate(fitted);
  if (!pointwise || pointwise.errors.some((r) => Math.abs(r) > MAX_CONTOUR_DEVIATION))
    return fitted;
  const coverage = renderedCoverage(fitted, render, contour, measured);
  if (!coverage || coverage.errors.every((r) => r <= MAX_CONTOUR_DEVIATION)) return fitted;
  let cached: { parameters: readonly number[]; value: Coverage } | null = null;
  const complete = (p: readonly number[]): Coverage | null => {
    const current = cached;
    if (current && p.every((value, i) => value === current.parameters[i])) return current.value;
    const pointwise = evaluate(p),
      coverage = renderedCoverage(p, render, contour, measured);
    if (!pointwise || !coverage) return null;
    const value = {
      errors: [...pointwise.errors, ...coverage.errors],
      jacobian: [...pointwise.jacobian, ...coverage.jacobian],
    };
    cached = { parameters: [...p], value };
    return value;
  };
  return optimizeGeometry(
    fitted,
    (p) => complete(p)?.errors ?? null,
    uncertainty,
    MAX_CONTOUR_DEVIATION,
    (p) => complete(p)?.jacobian ?? null,
    undefined,
    count,
  );
}

/** 连续扫角只用于生成轮廓，有效顺序和回描预算仍由最终轨迹校验负责。 */
function sweepAngles(angles: readonly number[]): number {
  return angles.slice(1).reduce((sum, angle, i) => {
    const delta = angle - angles[i]!;
    return sum + Math.atan2(Math.sin(delta), Math.cos(delta));
  }, 0);
}

/**
 * 生成与弦高预算共用分辨率的圆或圆弧点列，优化与最终输出使用同一轮廓。
 * @param fit 调用方已校验的有限圆心与正半径，使用归一化坐标。
 * @param start 起点在圆心坐标中的弧度方向。
 * @param sweep 有符号扫角；完整一圈首尾使用同一点。
 * @returns 规范点列，不修改参数，不抛异常。
 */
export function circleContour(fit: CircleGeometry, start: number, sweep: number): FitPoint[] {
  const result = Array.from({ length: CONIC_SEGMENTS + 1 }, (_, i) => {
    const angle = start + (sweep * i) / CONIC_SEGMENTS;
    return {
      x: fit.center.x + fit.radius * Math.cos(angle),
      y: fit.center.y + fit.radius * Math.sin(angle),
    };
  });
  if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-8) result[result.length - 1] = result[0]!;
  return result;
}

/**
 * 生成与覆盖验收共用的椭圆点列，避免参数优化和渲染采用不同近似。
 * @param fit 调用方已校验的有限中心、正半轴与长轴方向，使用归一化坐标。
 * @param start 椭圆局部坐标中的起始参数角，单位弧度。
 * @param sweep 有符号参数扫角；完整一圈首尾使用同一点。
 * @returns 规范点列，不修改参数，不抛异常。
 */
export function ellipseContour(fit: EllipseGeometry, start: number, sweep: number): FitPoint[] {
  const dx = Math.cos(fit.angle),
    dy = Math.sin(fit.angle);
  const result = Array.from({ length: CONIC_SEGMENTS + 1 }, (_, i) => {
    const angle = start + (sweep * i) / CONIC_SEGMENTS,
      x = fit.major * Math.cos(angle),
      y = fit.minor * Math.sin(angle);
    return { x: fit.center.x + x * dx - y * dy, y: fit.center.y + x * dy + y * dx };
  });
  if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-8) result[result.length - 1] = result[0]!;
  return result;
}

/** HyperSVD消除代数圆拟合的主要偏差，精确共圆点由最小奇异向量直接求解。 */
function hyperCircle(points: readonly FitPoint[]): CircleGeometry | null {
  const center = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
  const design = new Matrix(
    points.map((p) => {
      const x = p.x - center.x,
        y = p.y - center.y;
      return [x * x + y * y, x, y, 1];
    }),
  );
  const decomposition = new SingularValueDecomposition(design);
  if (decomposition.rank < 3) return null;
  const values = decomposition.diagonal,
    vectors = decomposition.rightSingularVectors;
  let coefficients: number[] | null;
  if (values[3]! <= values[0]! * 1e-12) {
    coefficients = vectors.getColumn(3);
  } else {
    const meanSquared = design.getColumn(0).reduce((s, z) => s + z, 0) / points.length;
    const inverseConstraint = new Matrix([
      [0, 0, 0, 0.5],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0.5, 0, 0, -2 * meanSquared],
    ]);
    const root = vectors.mmul(Matrix.diag(values)).mmul(vectors.transpose());
    const spectrum = new EigenvalueDecomposition(root.mmul(inverseConstraint).mmul(root), {
      assumeSymmetric: true,
    });
    const index = spectrum.realEigenvalues
      .map((value, i) => ({ value, i }))
      .filter((row) => row.value > 0)
      .sort((a, b) => a.value - b.value)[0]?.i;
    if (index === undefined) return null;
    coefficients = leastSquares(root.to2DArray(), spectrum.eigenvectorMatrix.getColumn(index));
  }
  if (!coefficients || Math.abs(coefficients[0]!) < 1e-12) return null;
  const [a, b, c, d] = coefficients;
  const x = -b! / (2 * a!),
    y = -c! / (2 * a!);
  const radius = Math.sqrt(x * x + y * y - d! / a!);
  return Number.isFinite(radius) && radius > 0
    ? { center: { x: center.x + x, y: center.y + y }, radius }
    : null;
}

/**
 * 以HyperSVD为起点，按真实径向距离做Huber–LM圆拟合；参考Chernov的Hyper fit。
 * @param points 至少四个有限归一化观测，调用方保留全部原始观测作最终校验。
 * @param uncertainty 归一化位置不确定性。
 * @param observations 完整原始观测，仅用于约束最大偏差，不改变等弧长采样的拟合权重。
 * @param contour 完整静态轨迹，反向覆盖不能只用重采样点列代替。
 * @returns 圆参数；共线、退化或不收敛到有限正半径返回null，数值库异常向上传播。
 */
export function fitCircleGeometry(
  points: readonly FitPoint[],
  uncertainty: number,
  observations: readonly FitPoint[] = points,
  contour: readonly FitPoint[] = points,
): CircleGeometry | null {
  if (points.length < 4) return null;
  const initial = hyperCircle(points);
  if (!initial) return null;
  const measured = points === observations ? points : [...points, ...observations];
  const geometry = (p: readonly number[]): CircleGeometry => ({
    center: { x: p[0]!, y: p[1]! },
    radius: Math.exp(p[2]!),
  });
  const evaluate = (p: readonly number[]): Coverage | null => {
    const radius = Math.exp(p[2]!);
    if (!Number.isFinite(radius) || radius <= 0) return null;
    return {
      errors: measured.map((point) => Math.hypot(point.x - p[0]!, point.y - p[1]!) - radius),
      jacobian: measured.map((point) => {
        const dx = point.x - p[0]!,
          dy = point.y - p[1]!,
          length = Math.hypot(dx, dy);
        return [length > 0 ? -dx / length : 0, length > 0 ? -dy / length : 0, -radius];
      }),
    };
  };
  const fitted = optimizeConic({
    initial: [initial.center.x, initial.center.y, Math.log(initial.radius)],
    evaluate,
    measured,
    contour,
    count: points.length,
    uncertainty,
    render: (p) => {
      const fit = geometry(p);
      if (!Number.isFinite(fit.radius) || fit.radius <= 0) return null;
      const angles = contour.map((point) =>
        Math.atan2(point.y - fit.center.y, point.x - fit.center.x),
      );
      const sweep = sweepAngles(angles);
      return circleContour(
        fit,
        angles[0]!,
        distance(contour[0]!, contour.at(-1)!) <= 0.12 ? Math.sign(sweep) * 2 * Math.PI : sweep,
      );
    },
    approximation: (p) => {
      const margin = Math.exp(p[2]!) * CHORD_DEVIATION;
      return { margin, gradient: [0, 0, margin] };
    },
  });
  return fitted ? geometry(fitted) : null;
}

/** Halíř–Flusser约束4ac-b²>0；线性部分通过SVD消元，避免显式求逆放大数值误差。 */
function constrainedEllipse(points: readonly FitPoint[]): EllipseGeometry | null {
  const origin = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
  const scale = Math.sqrt(
    points.reduce((s, p) => s + (p.x - origin.x) ** 2 + (p.y - origin.y) ** 2, 0) /
      (2 * points.length),
  );
  if (!(scale > 1e-12)) return null;
  const local = points.map((p) => ({ x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale }));
  const quadratic = new Matrix(local.map((p) => [p.x * p.x, p.x * p.y, p.y * p.y]));
  const linear = new SingularValueDecomposition(new Matrix(local.map((p) => [p.x, p.y, 1])));
  if (linear.rank < 3) return null;
  const transform = linear.solve(quadratic).mul(-1);
  const projection = quadratic
    .transpose()
    .mmul(quadratic)
    .add(
      quadratic
        .transpose()
        .mmul(new Matrix(local.map((p) => [p.x, p.y, 1])))
        .mmul(transform),
    );
  const spectrum = new EigenvalueDecomposition(
    new Matrix([
      [0, 0, 0.5],
      [0, -1, 0],
      [0.5, 0, 0],
    ]).mmul(projection),
  );
  const vectors = spectrum.eigenvectorMatrix;
  const index = spectrum.realEigenvalues.findIndex(
    (_, i) =>
      spectrum.imaginaryEigenvalues[i] === 0 &&
      4 * vectors.get(0, i) * vectors.get(2, i) - vectors.get(1, i) ** 2 > 0,
  );
  if (index < 0) return null;
  const coefficients = vectors.getColumn(index);
  const tail = transform.mmul(Matrix.columnVector(coefficients)).to1DArray();
  const sign = coefficients[0]! + coefficients[2]! < 0 ? -1 : 1;
  const [a, b, c, d, e, g] = [...coefficients, ...tail].map((value) => sign * value);
  const determinant = a! * c! - b! ** 2 / 4;
  const x = ((b! * e!) / 2 - c! * d!) / (2 * determinant),
    y = ((b! * d!) / 2 - a! * e!) / (2 * determinant);
  const constant = -g! + a! * x * x + b! * x * y + c! * y * y;
  const separation = Math.hypot(a! - c!, b!);
  const major = scale * Math.sqrt((2 * constant) / (a! + c! - separation));
  const minor = scale * Math.sqrt((2 * constant) / (a! + c! + separation));
  if (![x, y, major, minor].every(Number.isFinite) || minor <= 0) return null;
  return {
    center: { x: origin.x + scale * x, y: origin.y + scale * y },
    major,
    minor,
    angle: Math.atan2(b!, a! - c!) / 2 + Math.PI / 2,
  };
}

/** 椭圆最近点的拉格朗日乘子由有界Newton求解；包括内部点与长轴上的特殊解。 */
function ellipseObservation(
  point: FitPoint,
  ellipse: EllipseGeometry,
): { residual: number; gradient: number[] } {
  const { center, major: a, minor: b, angle } = ellipse;
  const dx = point.x - center.x,
    dy = point.y - center.y;
  const rawX = dx * Math.cos(angle) + dy * Math.sin(angle),
    rawY = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const x = Math.abs(rawX),
    y = Math.abs(rawY);
  const outside = (x / a) ** 2 + (y / b) ** 2 >= 1;
  let nearestX: number, nearestY: number;
  if (y === 0) {
    const difference = a * a - b * b;
    const ratio = difference > 0 ? (a * x) / difference : 1;
    nearestX = ratio < 1 ? a * ratio : a;
    nearestY = ratio < 1 ? b * Math.sqrt(1 - ratio * ratio) : 0;
  } else {
    let low = outside ? 0 : b * y - b * b;
    let high = outside ? Math.hypot(a * x, b * y) - b * b : 0;
    let t = (low + high) / 2;
    for (let i = 0; i < 32; i++) {
      const u = (a * x) / (t + a * a),
        v = (b * y) / (t + b * b);
      const value = u * u + v * v - 1;
      if (Math.abs(value) < 1e-12) break;
      if (value > 0) low = t;
      else high = t;
      const next = t + value / (2 * ((u * u) / (t + a * a) + (v * v) / (t + b * b)));
      t = next > low && next < high ? next : (low + high) / 2;
    }
    nearestX = (a * a * x) / (t + a * a);
    nearestY = (b * b * y) / (t + b * b);
  }
  const u = nearestX * (rawX < 0 ? -1 : 1),
    v = nearestY * (rawY < 0 ? -1 : 1);
  const length = Math.hypot(u / (a * a), v / (b * b));
  const nx = u / (a * a * length),
    ny = v / (b * b * length);
  // 最近点的法向给出距离对边界运动的解析导数，无须对每个参数重复求最近点。
  return {
    residual: Math.hypot(x - nearestX, y - nearestY) * (outside ? 1 : -1),
    gradient: [
      -nx * Math.cos(angle) + ny * Math.sin(angle),
      -nx * Math.sin(angle) - ny * Math.cos(angle),
      -nx * u,
      -ny * v,
      nx * v - ny * u,
    ],
  };
}

/**
 * 复合图形复用椭圆的精确有符号距离，不使用代数残差或多边形近似替代。
 * @param point 有限归一化观测。
 * @param ellipse 有限中心、major≥minor>0及方向。
 * @returns 最近轮廓距离，内部为负；参数前置条件由联合拟合器校验。
 */
export function ellipseDistance(point: FitPoint, ellipse: EllipseGeometry): number {
  return ellipseObservation(point, ellipse).residual;
}

/**
 * Halíř–Flusser稳定约束初始化，再以最近轮廓距离做Huber–LM椭圆拟合。
 * @param points 至少六个有限归一化观测。
 * @param uncertainty 归一化位置不确定性，不能代替完整观测的最终偏差检查。
 * @param observations 完整原始观测，仅约束最大偏差，避免停笔密集采样改变拟合权重。
 * @param contour 完整静态轨迹，反向覆盖与最终渲染使用同一轮廓。
 * @param closed 是否拟合完整闭合边界；开放弧仅生成实际扫过的椭圆段。
 * @returns 有限椭圆参数；秩亏、退化或无有效椭圆返回null，数值库异常向上传播。
 */
export function fitEllipseGeometry(
  points: readonly FitPoint[],
  uncertainty: number,
  observations: readonly FitPoint[] = points,
  contour: readonly FitPoint[] = points,
  closed = true,
): EllipseGeometry | null {
  if (points.length < 6) return null;
  const initial = constrainedEllipse(points);
  if (!initial) return null;
  const measured = points === observations ? points : [...points, ...observations];
  const geometry = (p: readonly number[]): EllipseGeometry => {
    const a = Math.exp(p[2]!),
      b = Math.exp(p[3]!);
    return {
      center: { x: p[0]!, y: p[1]! },
      major: Math.max(a, b),
      minor: Math.min(a, b),
      angle: p[4]! + (b > a ? Math.PI / 2 : 0),
    };
  };
  const evaluate = (p: readonly number[]): Coverage | null => {
    const ellipse = geometry(p);
    if (!(ellipse.minor > 0) || !Number.isFinite(ellipse.major)) return null;
    const values = measured.map((point) => ellipseObservation(point, ellipse)),
      swapped = Math.exp(p[3]!) > Math.exp(p[2]!);
    return {
      errors: values.map((value) => value.residual),
      jacobian: values.map((value) => {
        const g = value.gradient;
        return swapped ? [g[0]!, g[1]!, g[3]!, g[2]!, g[4]!] : g;
      }),
    };
  };
  const fitted = optimizeConic({
    initial: [
      initial.center.x,
      initial.center.y,
      Math.log(initial.major),
      Math.log(initial.minor),
      initial.angle,
    ],
    evaluate,
    measured,
    contour,
    count: points.length,
    uncertainty,
    render: (p) => {
      const ellipse = geometry(p),
        dx = Math.cos(ellipse.angle),
        dy = Math.sin(ellipse.angle);
      if (!(ellipse.minor > 0) || !Number.isFinite(ellipse.major)) return null;
      const angles = contour.map((point) =>
        Math.atan2(
          (-(point.x - ellipse.center.x) * dy + (point.y - ellipse.center.y) * dx) / ellipse.minor,
          ((point.x - ellipse.center.x) * dx + (point.y - ellipse.center.y) * dy) / ellipse.major,
        ),
      );
      const sweep = sweepAngles(angles);
      return ellipseContour(ellipse, angles[0]!, closed ? Math.sign(sweep) * 2 * Math.PI : sweep);
    },
    approximation: (p) => {
      const a = Math.exp(p[2]!),
        b = Math.exp(p[3]!),
        margin = Math.max(a, b) * CHORD_DEVIATION;
      return { margin, gradient: [0, 0, a >= b ? margin : 0, b > a ? margin : 0, 0] };
    },
  });
  return fitted ? geometry(fitted) : null;
}
