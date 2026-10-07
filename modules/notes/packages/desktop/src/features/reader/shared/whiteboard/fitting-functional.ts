import { noiseScale } from "./fitting-noise";
import { Matrix, SingularValueDecomposition } from "ml-matrix";
import { curveStructure, curveStructureAgrees } from "./fitting-curve-structure";
import { leastSquares, traceAdvance, type FitPoint } from "./fitting-math";
import { optimizeGeometry } from "./fitting-optimization";
import { realCubicRoots } from "./fitting-polynomial";

/** 参数化数学曲线只规范有充分轮廓证据的函数族，其他轨迹继续保形平滑。 */
export type FunctionalCurveFit = {
  label: "parabola" | "hyperbola" | "sine";
  points: FitPoint[];
  parameters: number;
};
/** 最近点参数与真实有符号距离属于同一几何，不使用代数残差冒充轮廓偏差。 */
type Projection = { at: number; residual: number };
/** 参数固定后统一进行最近点、有限区间渲染与顺序验收。 */
type FunctionalGeometry = {
  project: (point: FitPoint) => Projection;
  point: (at: number) => FitPoint;
};
type FunctionalFamily = {
  label: FunctionalCurveFit["label"];
  initial: number[];
  geometry: (p: readonly number[]) => FunctionalGeometry | null;
};

const local = (point: FitPoint, angle: number, center: FitPoint = { x: 0, y: 0 }) => ({
  x: (point.x - center.x) * Math.cos(angle) + (point.y - center.y) * Math.sin(angle),
  y: -(point.x - center.x) * Math.sin(angle) + (point.y - center.y) * Math.cos(angle),
});
const world = (point: FitPoint, angle: number, center: FitPoint = { x: 0, y: 0 }) => ({
  x: center.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
  y: center.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
});

/** 全部三次驻点与端点共同决定最近点，避免抛物线内部点被局部Newton锁到较远分支。 */
function parabola(initial: readonly number[]): FunctionalFamily {
  return {
    label: "parabola",
    initial: [...initial],
    geometry: (p) => {
      const a = p[0]!,
        b = p[1]!,
        c = p[2]!,
        angle = p[3]!;
      if (!p.every(Number.isFinite) || Math.abs(a) < 0.025 || Math.abs(a) > 30) return null;
      const value = (at: number) => a * at * at + b * at + c;
      return {
        point: (at) => world({ x: at, y: value(at) }, angle),
        project: (point) => {
          const q = local(point, angle),
            roots = realCubicRoots([
              b * (c - q.y) - q.x,
              1 + b * b + 2 * a * (c - q.y),
              3 * a * b,
              2 * a * a,
            ]);
          let best = Infinity,
            at = q.x;
          for (const t of roots) {
            const error = Math.hypot(t - q.x, value(t) - q.y);
            if (error < best) {
              best = error;
              at = t;
            }
          }
          return { at, residual: best * Math.sign(q.y - value(at) || 1) };
        },
      };
    },
  };
}

/** 稳定隐式圆锥初始化只提供轴与中心，最终目标始终是最近轮廓距离。 */
function implicitConic(points: readonly FitPoint[]): number[] | null {
  const matrix = new Matrix(points.map((p) => [p.x * p.x, p.x * p.y, p.y * p.y, p.x, p.y, 1]));
  const svd = new SingularValueDecomposition(matrix);
  return svd.rank < 5 ? null : svd.rightSingularVectors.getColumn(5);
}

function hyperbolaFamily(
  coefficients: readonly number[],
  points: readonly FitPoint[],
): FunctionalFamily | null {
  const [A, B, C, D, E, F] = coefficients,
    det = A! * C! - (B! * B!) / 4;
  if (det >= -1e-8) return null;
  const center = {
      x: ((B! * E!) / 2 - C! * D!) / (2 * det),
      y: ((B! * D!) / 2 - A! * E!) / (2 * det),
    },
    constant = F! + (D! * center.x + E! * center.y) / 2;
  let angle = 0.5 * Math.atan2(B!, A! - C!),
    first =
      A! * Math.cos(angle) ** 2 +
      B! * Math.sin(angle) * Math.cos(angle) +
      C! * Math.sin(angle) ** 2,
    second = A! + C! - first;
  if (-constant / first <= 0) {
    angle += Math.PI / 2;
    [first, second] = [second, first];
  }
  const a = Math.sqrt(-constant / first),
    b = Math.sqrt(constant / second);
  if (
    ![a, b, center.x, center.y].every(Number.isFinite) ||
    Math.min(a, b) < 0.025 ||
    Math.max(a, b) > 3 ||
    Math.hypot(center.x, center.y) > 4
  )
    return null;
  const sign = Math.sign(points.reduce((sum, p) => sum + local(p, angle, center).x, 0));
  if (sign === 0) return null;
  return {
    label: "hyperbola",
    initial: [center.x, center.y, Math.log(a), Math.log(b), angle],
    geometry: (p) => {
      const a = Math.exp(p[2]!),
        b = Math.exp(p[3]!),
        center = { x: p[0]!, y: p[1]! },
        angle = p[4]!;
      if (
        !p.every(Number.isFinite) ||
        Math.min(a, b) < 0.01 ||
        Math.max(a, b) > 4 ||
        Math.hypot(center.x, center.y) > 5
      )
        return null;
      return {
        point: (at) => world({ x: sign * a * Math.sqrt(1 + at * at), y: b * at }, angle, center),
        project: (point) => {
          const q = local(point, angle, center),
            k = a * a + b * b,
            linear = sign * a * q.x;
          const bound = 1 + (Math.abs(a * q.x) + Math.abs(b * q.y)) / k,
            critical = linear > k ? Math.sqrt((linear / k) ** (2 / 3) - 1) : 0,
            breaks = critical > 0 ? [-bound, -critical, critical, bound] : [-bound, bound];
          const derivative = (s: number) => k * s - (linear * s) / Math.sqrt(1 + s * s) - b * q.y;
          const candidates = [...breaks];
          for (let i = 1; i < breaks.length; i++) {
            let lower = breaks[i - 1]!,
              upper = breaks[i]!,
              low = derivative(lower),
              high = derivative(upper);
            if (low * high > 0) continue;
            let s = (lower + upper) / 2;
            for (let step = 0; step < 32; step++) {
              const value = derivative(s);
              if (Math.abs(value) < 1e-12) break;
              if (low * value <= 0) {
                upper = s;
                high = value;
              } else {
                lower = s;
                low = value;
              }
              const slope = k - linear / (1 + s * s) ** 1.5,
                next = s - value / slope;
              s =
                Number.isFinite(next) && next > lower && next < upper ? next : (lower + upper) / 2;
            }
            candidates.push(s);
          }
          let at = 0,
            best = Infinity;
          for (const s of candidates) {
            const value = Math.hypot(sign * a * Math.sqrt(1 + s * s) - q.x, b * s - q.y);
            if (value < best) {
              best = value;
              at = s;
            }
          }
          return { at, residual: best * Math.sign(q.x - sign * a * Math.sqrt(1 + at * at) || 1) };
        },
      };
    },
  };
}

function parabolaFamilies(
  points: readonly FitPoint[],
  coefficients: readonly number[] | null,
): FunctionalFamily[] {
  const first = points[0]!,
    last = points.at(-1)!,
    base = Math.atan2(last.y - first.y, last.x - first.x),
    angles = [base, base + Math.PI / 2];
  if (coefficients) {
    const [A, B, C] = coefficients,
      axis = 0.5 * Math.atan2(B!, A! - C!);
    angles.push(axis, axis + Math.PI / 2);
  }
  return angles.flatMap((angle) => {
    const coordinates = points.map((p) => local(p, angle)),
      fit = leastSquares(
        coordinates.map((p) => [p.x * p.x, p.x, 1]),
        coordinates.map((p) => p.y),
      );
    if (!fit || Math.abs(fit[0]!) < 0.025) return [];
    const rms = Math.sqrt(
      coordinates.reduce(
        (sum, p) => sum + (fit[0]! * p.x * p.x + fit[1]! * p.x + fit[2]! - p.y) ** 2,
        0,
      ) / points.length,
    );
    return rms > 0.06 ? [] : [parabola([...fit, angle])];
  });
}

/** 周期搜索提供可重复初值，最近点Newton受几何距离给出的有限搜索域约束。 */
function sineFamilies(points: readonly FitPoint[]): FunctionalFamily[] {
  const first = points[0]!,
    last = points.at(-1)!,
    base = Math.atan2(last.y - first.y, last.x - first.x);
  const starts: Array<{ p: number[]; error: number }> = [];
  for (const offset of [-0.2, 0, 0.2]) {
    const angle = base + offset,
      coordinates = points.map((p) => local(p, angle)),
      span = Math.max(...coordinates.map((p) => p.x)) - Math.min(...coordinates.map((p) => p.x));
    if (span < 0.2) continue;
    const variance =
      Math.max(...coordinates.map((p) => p.y)) - Math.min(...coordinates.map((p) => p.y));
    if (variance < 0.06) continue;
    for (let step = 0; step < 48; step++) {
      const frequency = ((0.8 + (step * 3.2) / 47) * 2 * Math.PI) / span,
        fitted = leastSquares(
          coordinates.map((p) => [1, Math.sin(frequency * p.x), Math.cos(frequency * p.x)]),
          coordinates.map((p) => p.y),
        );
      if (!fitted) continue;
      const amplitude = Math.hypot(fitted[1]!, fitted[2]!);
      if (amplitude < 0.03 || amplitude > 1) continue;
      const error = Math.sqrt(
        coordinates.reduce(
          (sum, p) =>
            sum +
            (fitted[0]! +
              fitted[1]! * Math.sin(frequency * p.x) +
              fitted[2]! * Math.cos(frequency * p.x) -
              p.y) **
              2,
          0,
        ) / points.length,
      );
      starts.push({
        p: [
          fitted[0]!,
          angle,
          Math.log(amplitude),
          Math.log(frequency),
          Math.atan2(fitted[2]!, fitted[1]!),
        ],
        error,
      });
    }
  }
  return starts
    .sort((a, b) => a.error - b.error)
    .slice(0, 3)
    .filter((start) => start.error < 0.045)
    .map((start) => ({
      label: "sine",
      initial: start.p,
      geometry: (p) => {
        const offset = p[0]!,
          angle = p[1]!,
          amplitude = Math.exp(p[2]!),
          frequency = Math.exp(p[3]!),
          phase = p[4]!;
        if (
          !p.every(Number.isFinite) ||
          amplitude < 0.025 ||
          amplitude > 1 ||
          frequency < Math.PI ||
          frequency > 40
        )
          return null;
        const value = (x: number) => offset + amplitude * Math.sin(frequency * x + phase);
        return {
          point: (at) => world({ x: at, y: value(at) }, angle),
          project: (point) => {
            const q = local(point, angle),
              radius = Math.abs(value(q.x) - q.y),
              lower = q.x - radius,
              upper = q.x + radius;
            let at = q.x,
              best = radius;
            const count = Math.max(1, Math.ceil(((upper - lower) * frequency * 4) / Math.PI));
            for (let i = 0; i <= count; i++) {
              let x = lower + ((upper - lower) * i) / count;
              for (let step = 0; step < 8; step++) {
                const y = value(x),
                  slope = amplitude * frequency * Math.cos(frequency * x + phase),
                  curvature = -amplitude * frequency * frequency * Math.sin(frequency * x + phase),
                  derivative = 1 + slope * slope + (y - q.y) * curvature;
                if (derivative <= 1e-10) break;
                const next = Math.max(
                  lower,
                  Math.min(upper, x - (x - q.x + (y - q.y) * slope) / derivative),
                );
                if (Math.hypot(next - q.x, value(next) - q.y) >= Math.hypot(x - q.x, y - q.y))
                  break;
                x = next;
              }
              const error = Math.hypot(x - q.x, value(x) - q.y);
              if (error < best) {
                best = error;
                at = x;
              }
            }
            return { at, residual: best * Math.sign(q.y - value(at) || 1) };
          },
        };
      },
    }));
}

/**
 * 对抛物线、双曲线单分支和正弦曲线做真实轮廓距离的鲁棒联合拟合。
 * @param sampled 等弧长有限归一化采样。
 * @param trace 原顺序的静态轨迹，不能把折返改成单调函数。
 * @param observations 全部真实观测，仅作为最大偏差约束。
 * @param source 完整静态轮廓，用于交叉结构验证，不隐藏真实小环。
 * @param uncertainty 归一化位置不确定性。
 * @returns 有限参数区间的可信候选；明确尖角、退化或拓扑不符返回空数组。
 * @throws 数值库异常向上传播；数学族不成立时由调用方继续通用曲线拟合。
 */
export function fitFunctionalCurves(
  sampled: readonly FitPoint[],
  trace: readonly FitPoint[],
  observations: readonly FitPoint[],
  source: readonly FitPoint[],
  uncertainty: number,
): FunctionalCurveFit[] {
  const noise = noiseScale(sampled, false),
    allowance = Math.min(0.03, noise * 6),
    structure = curveStructure(source, 0.0008, allowance);
  if (!structure || structure.crossings.length > 0) return [];
  const coefficients = implicitConic(sampled),
    families = parabolaFamilies(sampled, coefficients),
    hyper = coefficients ? hyperbolaFamily(coefficients, sampled) : null;
  if (hyper) families.push(hyper);
  families.push(...sineFamilies(sampled));
  const data = [...sampled, ...observations],
    result: FunctionalCurveFit[] = [];
  for (const family of families) {
    const fit = optimizeGeometry(
        family.initial,
        (p) => {
          const geometry = family.geometry(p);
          return geometry ? data.map((point) => geometry.project(point).residual) : null;
        },
        uncertainty,
        0.075,
        undefined,
        undefined,
        sampled.length,
      ),
      geometry = fit ? family.geometry(fit) : null;
    if (!geometry) continue;
    // 数学函数族需要残差与实测噪声相符，不能只凭通用修形预算把双曲线改成近似抛物线。
    const rms = Math.sqrt(
      sampled.reduce((sum, p) => sum + geometry.project(p).residual ** 2, 0) / sampled.length,
    );
    if (rms > Math.max(0.001, noise * 2.5)) continue;
    const parameters = trace.map((point) => geometry.project(point).at),
      advance = traceAdvance(parameters.slice(1).map((t, i) => t - parameters[i]!));
    if (advance === null) continue;
    const start = geometry.project(sampled[0]!).at,
      end = geometry.project(sampled.at(-1)!).at;
    const points = Array.from({ length: 193 }, (_, i) =>
      geometry.point(start + ((end - start) * i) / 192),
    );
    const rendered = curveStructure(points, 0.0008, allowance);
    if (
      points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      rendered &&
      curveStructureAgrees(structure, rendered)
    )
      result.push({ label: family.label, points, parameters: family.initial.length + 2 });
  }
  return result;
}
