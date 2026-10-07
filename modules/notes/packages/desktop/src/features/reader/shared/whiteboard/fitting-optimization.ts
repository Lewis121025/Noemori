import { Matrix, QrDecomposition } from "ml-matrix";

/** 几何残差必须对应同一组原始观测；非法参数返回null，不能删点改变目标。 */
type Residuals = (parameters: readonly number[]) => number[] | null;
/** 解析雅可比的行与残差一一对应，列与几何参数一一对应，不允许删点改变目标。 */
type Jacobian = (parameters: readonly number[]) => number[][] | null;
/** 规范曲线转成渲染点列的几何误差上界及参数导数，必须纳入同一观测偏差预算。 */
type Approximation = (parameters: readonly number[]) => { margin: number; gradient: number[] };

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 有解析导数时直接使用；其余几何以同一有限差分契约求导，不改变最小化目标。 */
function geometryDerivatives(
  parameters: readonly number[],
  errors: readonly number[],
  residuals: Residuals,
  jacobian?: Jacobian,
): number[][] | null {
  if (jacobian) {
    const rows = jacobian(parameters);
    if (
      !rows ||
      rows.length !== errors.length ||
      !rows.every((row) => row.length === parameters.length && row.every(Number.isFinite))
    )
      return null;
    return parameters.map((_, j) => rows.map((row) => row[j]!));
  }
  const columns = parameters.map((value, column) => {
    const h = 1e-6 * (1 + Math.abs(value)),
      perturbed = [...parameters];
    perturbed[column] = value + h;
    const shifted = residuals(perturbed);
    return shifted?.length === errors.length && shifted.every(Number.isFinite)
      ? shifted.map((r, i) => (r - errors[i]!) / h)
      : null;
  });
  const valid = columns.filter((column) => column !== null);
  return valid.length === parameters.length ? valid : null;
}

/** Huber观测、有效不等式与LM阻尼组成增广系统，由QR直接求步长。 */
function dampedStep(
  columns: readonly number[][],
  errors: readonly number[],
  cutoff: number,
  damping: number,
  penalty: number,
  constraint: (value: number, i: number) => number,
  marginGradient: readonly number[],
  fitCount: number,
): number[] | null {
  const rows = errors.slice(0, fitCount).map((r, i) => {
    const weight = Math.sqrt(Math.min(1, cutoff / Math.max(Math.abs(r), cutoff)));
    return columns.map((column) => weight * column[i]!);
  });
  const target = errors
    .slice(0, fitCount)
    .map((r) => -r * Math.sqrt(Math.min(1, cutoff / Math.max(Math.abs(r), cutoff))));
  errors.forEach((value, i) => {
    const violation = constraint(value, i);
    if (violation === 0) return;
    rows.push(
      columns.map(
        (column, j) => Math.sqrt(penalty) * (Math.sign(value) * column[i]! + marginGradient[j]!),
      ),
    );
    target.push(-Math.sqrt(penalty) * violation);
  });
  const scales = columns.map((_, j) => Math.sqrt(rows.reduce((sum, row) => sum + row[j]! ** 2, 0)));
  columns.forEach((_, j) => {
    rows.push(
      columns.map((_, k) => (j === k ? Math.sqrt(damping) * Math.max(scales[j]!, 1e-8) : 0)),
    );
    target.push(0);
  });
  const decomposition = new QrDecomposition(new Matrix(rows));
  return decomposition.isFullRank()
    ? decomposition.solve(Matrix.columnVector(target)).to1DArray()
    : null;
}

/**
 * Huber几何残差的Levenberg–Marquardt优化，增广雅可比由QR求解，不形成正规方程。
 * @param initial 有限初始几何参数；半轴由调用方使用对数参数保证为正。
 * @param residuals 返回到实际轮廓的有符号距离；每次必须保留相同观测数量。
 * @param uncertainty 归一化位置不确定性下限，与MAD共同确定Huber噪声尺度。
 * @param maximum 全部观测的最大几何偏差；有限时以增广拉格朗日约束优化，禁止只迁就多数点。
 * @param jacobian 可选解析导数；未提供时按有限差分求导，几何目标与约束相同。
 * @param approximation 渲染点列的误差上界；它只收紧可行域，不改变真实几何距离目标。
 * @param fitCount 参与统计目标的等弧长采样数；其余原始观测仅约束偏差，避免停笔密度改变权重。
 * @returns 每轮目标单调下降的参数；退化观测返回null。最多6轮各24步，异常向上传播。
 */
export function optimizeGeometry(
  initial: readonly number[],
  residuals: Residuals,
  uncertainty: number,
  maximum = Infinity,
  jacobian?: Jacobian,
  approximation?: Approximation,
  fitCount?: number,
): number[] | null {
  if (
    !initial.length ||
    !initial.every(Number.isFinite) ||
    !Number.isFinite(uncertainty) ||
    uncertainty < 0 ||
    !(maximum > 0)
  )
    return null;
  const first = residuals(initial);
  if (!first || first.length < initial.length || !first.every(Number.isFinite)) return null;
  const count = fitCount ?? first.length;
  if (!Number.isInteger(count) || count < initial.length || count > first.length) return null;
  let parameters = [...initial];
  let errors: number[] = first;
  const center = median(errors.slice(0, count));
  const cutoff =
    1.345 *
    Math.max(
      uncertainty,
      1.4826 * median(errors.slice(0, count).map((r) => Math.abs(r - center))),
      1e-8,
    );
  const huberCost = (values: readonly number[]) =>
    values.slice(0, count).reduce((sum, r) => {
      const absolute = Math.abs(r);
      return sum + (absolute <= cutoff ? (r * r) / 2 : cutoff * (absolute - cutoff / 2));
    }, 0);
  const bound = maximum * (1 - 1e-5);
  const multipliers = errors.map(() => 0);
  let penalty = 1;
  for (let phase = 0; phase < 6; phase++) {
    const cost = (values: readonly number[], p: readonly number[]) => {
      const margin = approximation?.(p).margin ?? 0;
      return (
        huberCost(values) +
        values.reduce((sum, value, i) => {
          const violation = Math.max(
            0,
            Math.abs(value) - bound + margin + multipliers[i]! / penalty,
          );
          return sum + (penalty * violation ** 2) / 2;
        }, 0)
      );
    };
    let objective = cost(errors, parameters),
      damping = 1e-3;
    for (let iteration = 0; iteration < 24; iteration++) {
      const columns = geometryDerivatives(parameters, errors, residuals, jacobian);
      if (!columns) break;
      const allowance = approximation?.(parameters) ?? {
        margin: 0,
        gradient: parameters.map(() => 0),
      };
      const constraint = (value: number, i: number) =>
        Math.max(0, Math.abs(value) - bound + allowance.margin + multipliers[i]! / penalty);
      const delta = dampedStep(
        columns,
        errors,
        cutoff,
        damping,
        penalty,
        constraint,
        allowance.gradient,
        count,
      );
      if (!delta) break;
      if (!delta.every(Number.isFinite) || Math.hypot(...delta) < 1e-8) break;
      const candidate = parameters.map((value, j) => value + delta[j]!);
      const next = candidate.every(Number.isFinite) ? residuals(candidate) : null;
      const nextCost =
        next?.length === errors.length && next.every(Number.isFinite)
          ? cost(next, candidate)
          : Infinity;
      if (next && nextCost < objective) {
        const improvement = objective - nextCost;
        parameters = candidate;
        errors = next;
        objective = nextCost;
        damping = Math.max(damping / 3, 1e-12);
        if (improvement < 1e-12 * (1 + objective)) break;
      } else {
        damping *= 10;
        if (damping > 1e12) break;
      }
    }
    const margin = approximation?.(parameters).margin ?? 0;
    if (errors.every((value) => Math.abs(value) + margin <= maximum)) break;
    errors.forEach((value, i) => {
      multipliers[i] = Math.max(0, multipliers[i]! + penalty * (Math.abs(value) - bound + margin));
    });
    penalty *= 10;
  }
  return parameters;
}
