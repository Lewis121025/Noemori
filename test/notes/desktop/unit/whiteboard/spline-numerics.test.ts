import { describe, expect, it } from "vitest";
import { solveSpline, splineContour, splinePoint } from "@reader/shared/whiteboard/fitting-spline";
import { segmentDistance } from "@reader/shared/whiteboard/fitting-math";
import {
  curveStructure,
  curveStructureAgrees,
} from "@reader/shared/whiteboard/fitting-curve-structure";
import reference from "../../fixtures/whiteboard/spline-reference.json";

describe("鲁棒三次样条的独立数值验证", () => {
  it.each(reference.cases)("与SciPy基函数和NumPy独立求解一致：$name", (test) => {
    const points = test.points.map(([x, y]) => ({ x: x!, y: y! }));
    const fit = solveSpline(
      points,
      test.parameters,
      test.count,
      test.periodic,
      test.penalty,
      test.cutoff,
    )!;
    expect(fit).not.toBeNull();
    fit.controls.forEach((point, i) => {
      expect(point.x).toBeCloseTo(test.controls[i]![0]!, 9);
      expect(point.y).toBeCloseTo(test.controls[i]![1]!, 9);
    });
    for (const derivative of [0, 1, 2] as const)
      test.at.forEach((at, i) => {
        const actual = splinePoint(fit, at, derivative),
          expected = test.evaluations[derivative]![i]!;
        expect(actual.x).toBeCloseTo(expected[0]!, 8);
        expect(actual.y).toBeCloseTo(expected[1]!, 8);
      });
    const tolerance = 1e-4,
      contour = splineContour(fit, tolerance)!;
    expect(contour).not.toBeNull();
    for (let i = 0; i <= 2000; i++) {
      const point = splinePoint(fit, i / 2000);
      expect(
        Math.min(...contour.slice(1).map((end, j) => segmentDistance(point, contour[j]!, end))),
      ).toBeLessThanOrEqual(tolerance);
    }
  });

  it("周期曲线在接缝严格保持位置、一阶和二阶导数连续", () => {
    const test = reference.cases[1]!,
      points = test.points.map(([x, y]) => ({ x: x!, y: y! })),
      fit = solveSpline(points, test.parameters, test.count, true, test.penalty, test.cutoff)!;
    for (const derivative of [0, 1, 2] as const) {
      const first = splinePoint(fit, 0, derivative),
        last = splinePoint(fit, 1, derivative);
      expect(first.x).toBeCloseTo(last.x, 9);
      expect(first.y).toBeCloseTo(last.y, 9);
    }
    expect(splineContour(fit, 1e-4)!.at(-1)).toEqual(splineContour(fit, 1e-4)![0]);
  });

  it("零惩罚恢复三次多项式，增加平滑仍精确固定开放端点", () => {
    const parameters = Array.from({ length: 33 }, (_, i) => i / 32),
      points = parameters.map((t) => ({ x: t, y: t ** 3 - 0.5 * t }));
    const fit = solveSpline(points, parameters, 12, false, 0, 1)!;
    for (const t of [0, 0.11, 0.53, 0.81, 1]) {
      expect(splinePoint(fit, t).x).toBeCloseTo(t, 10);
      expect(splinePoint(fit, t).y).toBeCloseTo(t ** 3 - 0.5 * t, 10);
    }
    const smooth = solveSpline(points, parameters, 12, false, 0.01, 1)!;
    expect(splinePoint(smooth, 0)).toEqual(points[0]);
    expect(splinePoint(smooth, 1)).toEqual(points.at(-1));
  });

  it("非法参数、重复参数和无法达到渲染容量的精度严格拒绝", () => {
    const parameters = Array.from({ length: 16 }, (_, i) => i / 15),
      points = parameters.map((t) => ({ x: t, y: Math.sin(t * 6) }));
    for (const count of [3, 17, 4.5])
      expect(solveSpline(points, parameters, count, false, 0, 1)).toBeNull();
    expect(
      solveSpline(
        points,
        parameters.map(() => 0),
        8,
        false,
        0,
        1,
      ),
    ).toBeNull();
    expect(solveSpline(points, parameters, 8, false, -1, 1)).toBeNull();
    expect(solveSpline(points, parameters, 8, false, 0, NaN)).toBeNull();
    const fit = solveSpline(points, parameters, 8, false, 0, 1)!;
    expect(splineContour(fit, 0)).toBeNull();
    expect(splineContour(fit, 1e-14)).toBeNull();
  });

  it("相同交叉数但位置、方向或访问顺序改变时拒绝，真实小环不被无噪声预算消除", () => {
    const points = [
      { x: -1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
      { x: 1, y: -1 },
    ];
    const structure = curveStructure(points, 0.001)!;
    expect(structure.crossings).toHaveLength(1);
    expect(curveStructureAgrees(structure, structure)).toBe(true);
    expect(curveStructureAgrees(structure, { ...structure, visits: [0, 1] })).toBe(false);
    expect(
      curveStructureAgrees(structure, {
        ...structure,
        crossings: structure.crossings.map((entry) => ({
          ...entry,
          orientation: -entry.orientation,
        })),
      }),
    ).toBe(false);
    expect(
      curveStructureAgrees(structure, {
        ...structure,
        crossings: structure.crossings.map((entry) => ({ ...entry, point: { x: 0.1, y: 0 } })),
      }),
    ).toBe(false);
    const small = points.map((point) => ({ x: point.x * 0.02, y: point.y * 0.02 }));
    expect(curveStructure(small, 0.0001)?.crossings).toHaveLength(1);
  });
});
