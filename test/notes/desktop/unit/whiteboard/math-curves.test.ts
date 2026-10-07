import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
function sampled(shape: (t: number) => InkPoint, rotation = 0, noise = 0): InkPoint[] {
  return Array.from({ length: 385 }, (_, i) => {
    const point = shape(i / 384),
      x = point.x + noise * Math.sin(i * 1.7),
      y = point.y + noise * Math.sin(i * 2.3);
    return p(
      500 + x * Math.cos(rotation) - y * Math.sin(rotation),
      300 + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  });
}

describe("开放圆锥曲线与严格正弦曲线", () => {
  it.each([0, 0.4, 1.2])("开口椭圆弧恢复同一椭圆参数并保持开口 %s", (rotation) => {
    const shape = (t: number) =>
        p(140 * Math.cos(1.5 * Math.PI * t), 55 * Math.sin(1.5 * Math.PI * t)),
      result = repairShape(sampled(shape, rotation, 0.5), 1);
    expect(result?.label).toBe("elliptical-arc");
    expect(contourDeviation(sampled(shape, rotation), result!.points)!.rms).toBeLessThan(0.6);
    expect(
      Math.hypot(
        result!.points[0]!.x - result!.points.at(-1)!.x,
        result!.points[0]!.y - result!.points.at(-1)!.y,
      ),
    ).toBeGreaterThan(100);
  });

  it.each([0, 0.47, 1.1])("抛物线恢复二次几何，不被半椭圆强行闭合 %s", (rotation) => {
    const shape = (t: number) => {
        const x = 320 * (t - 0.5);
        return p(x, (x * x) / 170);
      },
      result = repairShape(sampled(shape, rotation, 0.6), 1);
    expect(result?.label).toBe("parabola");
    expect(contourDeviation(sampled(shape, rotation), result!.points)!.rms).toBeLessThan(0.8);
  });

  it.each([0, 0.6])("双曲线保留同一分支与渐近走势 %s", (rotation) => {
    const shape = (t: number) => {
        const x = 35 + 220 * t;
        return p(x, 6200 / x);
      },
      result = repairShape(sampled(shape, rotation, 0.5), 1);
    expect(result?.label).toBe("hyperbola");
    expect(contourDeviation(sampled(shape, rotation), result!.points)!.rms).toBeLessThan(1);
  });

  it.each([0, 0.43])("正弦曲线恢复恒定周期、振幅和方向 %s", (rotation) => {
    const shape = (t: number) => p(360 * t, 60 * Math.sin(4 * Math.PI * t + 0.3)),
      result = repairShape(sampled(shape, rotation, 0.6), 1);
    expect(result?.label).toBe("sine");
    expect(contourDeviation(sampled(shape, rotation), result!.points)!.rms).toBeLessThan(1);
  });

  it("振幅和周期明显变化的自由曲线保形处理，不能强行规范为正弦", () => {
    const shape = (t: number) =>
        p(360 * t, (25 + 60 * t) * Math.sin(2 * Math.PI * (t + 2 * t * t))),
      result = repairShape(sampled(shape), 1);
    expect(result?.label).not.toBe("sine");
    if (result) expect(contourDeviation(sampled(shape), result.points)!.rms).toBeLessThan(3);
  });
});
