import { describe, expect, it } from "vitest";
import { leastSquares } from "@reader/shared/whiteboard/fitting-math";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { fitCircleGeometry, fitEllipseGeometry } from "@reader/shared/whiteboard/fitting-conics";
import { fitLineGeometry, refineRectangle } from "@reader/shared/whiteboard/fitting-lines";
import { optimizeGeometry } from "@reader/shared/whiteboard/fitting-optimization";
import { renderedCoverage } from "@reader/shared/whiteboard/fitting-coverage";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";
import { emptyWhiteboard } from "@reader/shared/whiteboard/model";
import contourEvidence from "../../fixtures/whiteboard/contour-evidence.json";

describe("白板拟合的数值条件", () => {
  it("渲染轮廓或扰动轮廓退化时拒绝覆盖求导，不产生缺失采样或运行错误", () => {
    const source = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const collapsed = () => [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(renderedCoverage([1], collapsed, source, source)).toBeNull();
    const render = (p: readonly number[]) => [
      { x: 0, y: 0 },
      { x: p[0]! < 1 ? p[0]! : 0, y: 0 },
    ];
    expect(renderedCoverage([0.999999], render, source, source)).toBeNull();
  });
  it.each([0, 0.7, 1.8])("位置优化不能改变原始曲率与分支身份或追认新角点 %s", async (rotation) => {
    for (const row of contourEvidence) {
      const points = row.points.map(([x, y]) => ({
        x: 300 + x! * Math.cos(rotation) - y! * Math.sin(rotation),
        y: -200 + x! * Math.sin(rotation) + y! * Math.cos(rotation),
        pressure: 0.5,
      }));
      const input = new WhiteboardInput(
        emptyWhiteboard(),
        () => {},
        async (request) => repairShape(request.points, request.scale, request.observations),
      );
      input.begin(points[0]!, false, row.timestamps_ms[0]);
      points.slice(1).forEach((point, i) => input.update(point, false, row.timestamps_ms[i + 1]));
      await input.hold();
      expect(input.correctedLabel, row.sample_id).toBe(row.expected);
      input.dispose();
    }
  });
  it("相近基函数仍能恢复参数，不能因正规方程平方条件数而误判退化", () => {
    const rows = Array.from({ length: 80 }, (_, i) => {
      const x = i / 79;
      return [1, x, x + 1e-6 * Math.sin(i)];
    });
    const targets = rows.map((row) => 2 * row[0]! + 3 * row[1]! + 4 * row[2]!);
    const result = leastSquares(rows, targets);
    expect(result).not.toBeNull();
    result!.forEach((value, i) => expect(value).toBeCloseTo([2, 3, 4][i]!, 5));
  });

  it("秩亏数据没有唯一几何解，必须拒绝而非产生任意参数", () => {
    expect(
      leastSquares(
        [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        [2, 4, 6],
      ),
    ).toBeNull();
  });

  it("带零均值径向抖动的短圆弧保留半径，不能被代数目标拉成小圆", () => {
    const points = Array.from({ length: 193 }, (_, i) => {
      const angle = -0.5 + i / 192;
      const radius = 100 + 3 * Math.sin(i * 1.73);
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), pressure: 0.5 };
    });
    const result = repairShape(points, 1);
    expect(result?.label).toBe("arc");
    const [a, b, c] = [result!.points[0]!, result!.points[64]!, result!.points[128]!];
    const determinant = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const squared = (point: typeof a) => point.x ** 2 + point.y ** 2;
    const cx =
      (squared(a) * (b.y - c.y) + squared(b) * (c.y - a.y) + squared(c) * (a.y - b.y)) /
      determinant;
    const cy =
      (squared(a) * (c.x - b.x) + squared(b) * (a.x - c.x) + squared(c) * (b.x - a.x)) /
      determinant;
    expect(Math.abs(Math.hypot(a.x - cx, a.y - cy) - 100)).toBeLessThan(3);
  });

  it("鲁棒目标必须同时满足每个观测的偏差，不能牺牲少数点来拟合多数点", () => {
    const observations = [0, 0, 0, 0.09];
    const fitted = optimizeGeometry(
      [0],
      (p) => observations.map((value) => p[0]! - value),
      0.005,
      0.05,
    );
    expect(fitted).not.toBeNull();
    for (const value of observations)
      expect(Math.abs(fitted![0]! - value)).toBeLessThanOrEqual(0.05);
    expect(fitted![0]).toBeCloseTo(0.04, 4);
  });

  it("渲染近似误差占用同一偏差预算，不能只验收解析曲线", () => {
    const observations = [0, 0, 0, 0.09],
      margin = 0.001;
    const fitted = optimizeGeometry(
      [0],
      (p) => observations.map((value) => p[0]! - value),
      0.005,
      0.05,
      () => observations.map(() => [1]),
      () => ({ margin, gradient: [0] }),
    );
    expect(fitted).not.toBeNull();
    for (const value of observations)
      expect(Math.abs(fitted![0]! - value) + margin).toBeLessThanOrEqual(0.05);
  });

  it("原始观测加密只增加约束，不能把拟合权重偏向停笔位置", () => {
    for (const count of [3, 100]) {
      const observations = [0, 1, ...Array<number>(count).fill(0)];
      const fitted = optimizeGeometry(
        [0],
        (p) => observations.map((value) => p[0]! - value),
        0.005,
        2,
        () => observations.map(() => [1]),
        undefined,
        2,
      );
      expect(fitted![0]).toBeCloseTo(0.5, 7);
    }
  });

  it.each([0, 0.7, 1.8])("短弧的低偏差拟合不依赖坐标轴方向 %s", (rotation) => {
    const points = Array.from({ length: 193 }, (_, i) => {
      const angle = rotation - 0.5 + i / 192;
      const radius = 0.5 + 0.015 * Math.sin(i * 1.73);
      return { x: 0.17 + radius * Math.cos(angle), y: -0.13 + radius * Math.sin(angle) };
    });
    const fitted = fitCircleGeometry(points, 0.005)!;
    expect(Math.hypot(fitted.center.x - 0.17, fitted.center.y + 0.13)).toBeLessThan(0.005);
    expect(Math.abs(fitted.radius - 0.5)).toBeLessThan(0.005);
  });

  it.each([0.2, 0.55, 0.92])("约束椭圆在不同长宽比中恢复真实半轴 %s", (ratio) => {
    for (const rotation of [0, 0.7, 1.8]) {
      const points = Array.from({ length: 192 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / 192;
        const noise = 0.003 * Math.sin(i * 1.73);
        const x = (0.5 + noise) * Math.cos(angle),
          y = (0.5 * ratio + noise) * Math.sin(angle);
        return {
          x: 0.17 + x * Math.cos(rotation) - y * Math.sin(rotation),
          y: -0.13 + x * Math.sin(rotation) + y * Math.cos(rotation),
        };
      });
      const fitted = fitEllipseGeometry(points, 0.005)!;
      expect(Math.hypot(fitted.center.x - 0.17, fitted.center.y + 0.13)).toBeLessThan(0.003);
      expect(Math.abs(fitted.major - 0.5)).toBeLessThan(0.003);
      expect(Math.abs(fitted.minor - 0.5 * ratio)).toBeLessThan(0.003);
      expect(Math.abs(Math.sin(fitted.angle - rotation))).toBeLessThan(0.01);
    }
  });

  it("单侧局部收笔尾巴不应拉偏直线整体方向", () => {
    const points = Array.from({ length: 80 }, (_, i) => ({
      x: i / 79 - 0.5,
      y: i < 74 ? 0.002 * Math.sin(i) : 0.05,
    }));
    const fitted = fitLineGeometry(points, 0.005)!;
    expect(Math.abs(Math.sin(fitted.angle))).toBeLessThan(0.01);
    expect(Math.abs(fitted.center.y)).toBeLessThan(0.005);
  });

  it("矩形联合优化消除离散方向扫描的角度误差，并保持精确直角", () => {
    const angle = 0.12345;
    const corners = [
      { x: -0.3, y: -0.2 },
      { x: 0.3, y: -0.2 },
      { x: 0.3, y: 0.2 },
      { x: -0.3, y: 0.2 },
      { x: -0.3, y: -0.2 },
    ];
    const rotate = (p: { x: number; y: number }, rotation: number) => ({
      x: p.x * Math.cos(rotation) - p.y * Math.sin(rotation),
      y: p.x * Math.sin(rotation) + p.y * Math.cos(rotation),
    });
    const points = corners.slice(1).flatMap((end, i) =>
      Array.from({ length: 48 }, (_, j) =>
        rotate(
          {
            x: corners[i]!.x + ((end.x - corners[i]!.x) * j) / 48,
            y: corners[i]!.y + ((end.y - corners[i]!.y) * j) / 48,
          },
          angle,
        ),
      ),
    );
    const fitted = refineRectangle(
      points,
      corners.map((p) => rotate(p, 0.13)),
      0.005,
    )!;
    const [a, b, c] = fitted;
    expect(Math.abs(Math.atan2(b!.y - a!.y, b!.x - a!.x) - angle)).toBeLessThan(1e-6);
    expect((b!.x - a!.x) * (c!.x - b!.x) + (b!.y - a!.y) * (c!.y - b!.y)).toBeCloseTo(0, 12);
  });
});
