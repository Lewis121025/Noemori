import { expect, it } from "vitest";
import {
  realCubicRoots,
  type CubicCoefficients,
} from "@reader/shared/whiteboard/fitting-polynomial";
it.each([
  { coefficients: [8, -6, -3, 1], roots: [-2, 1, 4] },
  { coefficients: [2, -3, 0, 1], roots: [-2, 1] },
  { coefficients: [-8, 12, -6, 1], roots: [2] },
  { coefficients: [-1, -1, 0, 1], roots: [1.324717957244746] },
  { coefficients: [-2, -1, 1, 0], roots: [-1, 2] },
  { coefficients: [5, -2, 0, 0], roots: [2.5] },
] as Array<{ coefficients: CubicCoefficients; roots: number[] }>)(
  "全部有限实根与独立因式/高精度参考一致：$coefficients",
  ({ coefficients, roots }) => {
    const actual = realCubicRoots(coefficients);
    expect(actual).toHaveLength(roots.length);
    for (const [i, root] of roots.entries()) expect(actual[i]).toBeCloseTo(root, 10);
    for (const scale of [1e-12, 1e12])
      expect(
        realCubicRoots([
          coefficients[0] * scale,
          coefficients[1] * scale,
          coefficients[2] * scale,
          coefficients[3] * scale,
        ]),
      ).toEqual(actual);
  },
);
it("二次公式避免大系数相消，同时保留远近两解", () => {
  const roots = realCubicRoots([1, -1e8, 1, 0]);
  expect(roots).toHaveLength(2);
  expect(roots[0]).toBeCloseTo(1e-8, 15);
  expect(roots[1]).toBeCloseTo(1e8, 5);
});
it("退化与非法多项式不伪造实根", () => {
  expect(realCubicRoots([0, 0, 0, 0])).toEqual([]);
  expect(realCubicRoots([1, 0, 1, 0])).toEqual([]);
  expect(realCubicRoots([0, 1, 0, NaN])).toEqual([]);
});
