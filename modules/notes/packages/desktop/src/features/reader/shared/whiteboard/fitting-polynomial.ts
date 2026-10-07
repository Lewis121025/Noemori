/** 多项式系数按常数项到最高次项排列，曲线最近点只能使用有限实根。 */
export type CubicCoefficients = readonly [number, number, number, number];

function quadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) <= scale * 1e-14) return Math.abs(b) <= scale * 1e-14 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c,
    tolerance = 1e-14 * (b * b + Math.abs(4 * a * c));
  if (discriminant < -tolerance) return [];
  if (Math.abs(discriminant) <= tolerance) return [-b / (2 * a)];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  return q === 0 ? [0] : [q / a, c / q];
}

/**
 * 稳定Cardano实根与Newton校正，二次退化采用避免相消的公式，不丢弃最近点的多解。
 * @param coefficients 有限常数、一阶、二阶、三阶系数。
 * @returns 所有可分辨有限实根，升序去重；零式或非法系数返回空数组，不抛异常。
 */
export function realCubicRoots(coefficients: CubicCoefficients): number[] {
  if (!coefficients.every(Number.isFinite)) return [];
  const [d, c, b, a] = coefficients,
    scale = Math.max(...coefficients.map(Math.abs));
  if (scale === 0) return [];
  let roots: number[];
  if (Math.abs(a) <= scale * 1e-14) roots = quadratic(b, c, d);
  else {
    const A = b / a,
      B = c / a,
      C = d / a,
      p = B - (A * A) / 3,
      q = (2 * A * A * A) / 27 - (A * B) / 3 + C,
      discriminant = (q * q) / 4 + (p * p * p) / 27,
      tolerance = 1e-14 * ((q * q) / 4 + Math.abs((p * p * p) / 27));
    if (discriminant > tolerance) {
      const u = Math.cbrt(-q / 2 - (q < 0 ? -1 : 1) * Math.sqrt(discriminant)),
        v = u === 0 ? 0 : -p / (3 * u);
      roots = [u + v - A / 3];
    } else if (discriminant >= -tolerance) {
      const u = Math.cbrt(-q / 2);
      roots = [2 * u - A / 3, -u - A / 3];
    } else {
      const radius = 2 * Math.sqrt(-p / 3),
        angle = Math.acos(Math.max(-1, Math.min(1, -q / (2 * Math.sqrt(-(p * p * p) / 27))))) / 3;
      roots = [0, 1, 2].map((i) => radius * Math.cos(angle - (i * 2 * Math.PI) / 3) - A / 3);
    }
  }
  return roots
    .map((root) => {
      for (let i = 0; i < 2; i++) {
        const residual = ((a * root + b) * root + c) * root + d,
          derivative = (3 * a * root + 2 * b) * root + c;
        if (!Number.isFinite(residual) || Math.abs(derivative) < scale * 1e-14) break;
        const next = root - residual / derivative;
        if (!Number.isFinite(next)) break;
        root = next;
      }
      return root;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .filter(
      (root, i, all) => i === 0 || Math.abs(root - all[i - 1]!) > 1e-10 * (1 + Math.abs(root)),
    );
}
