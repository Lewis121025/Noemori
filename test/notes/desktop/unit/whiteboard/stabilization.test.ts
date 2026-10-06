import { describe, expect, it } from "vitest";
import { fitShape } from "@reader/shared/whiteboard/fitting";
import { stabilizeTrace } from "@reader/shared/whiteboard/stabilization";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.6 });

/** 停笔微抖限定在真实末点一像素内，不改变此前图形的完整结构。 */
function pauseJitter(points: InkPoint[], amplitude = 1, count = 48): InkPoint[] {
  const last = points.at(-1)!;
  return [
    ...points,
    ...Array.from({ length: count }, (_, i) =>
      p(
        last.x + (amplitude * Math.sin((i + 1) * 1.3)) / Math.SQRT2,
        last.y + (amplitude * Math.sin((i + 1) * 1.7)) / Math.SQRT2,
      ),
    ),
  ];
}

describe("停笔微抖与拟合候选", () => {
  it.each([0, 0.41, 1.3])("小尺寸直线的停笔微抖不应消耗大范围重描预算 %s", (angle) => {
    const source = Array.from({ length: 97 }, (_, i) =>
      p(((40 * i) / 96) * Math.cos(angle), ((40 * i) / 96) * Math.sin(angle)),
    );
    const points = pauseJitter(source);
    const original = structuredClone(points);
    const result = fitShape(points, { label: "line", confidence: 0.99 }, 1)!.points;
    expect(result).toHaveLength(2);
    expect(Math.hypot(result[0]!.x, result[0]!.y)).toBeLessThan(1);
    expect(
      Math.hypot(result[1]!.x - source.at(-1)!.x, result[1]!.y - source.at(-1)!.y),
    ).toBeLessThan(1.5);
    expect(points).toEqual(original);
  });

  it("共线的大范围折返不能被去抖压成直线，重复整圈不能被压成一圈", () => {
    for (const points of [
      [p(0, 0), p(40, 0), p(0, 0), p(40, 0)],
      pauseJitter([p(0, 0), p(40, 0), p(0, 0), p(40, 0)]),
    ])
      expect(fitShape(points, { label: "line", confidence: 0.99 }, 1)).toBeNull();
    const circle = Array.from({ length: 257 }, (_, i) =>
      p(20 * Math.cos((4 * Math.PI * i) / 256), 20 * Math.sin((4 * Math.PI * i) / 256)),
    );
    expect(fitShape(pauseJitter(circle), { label: "circle", confidence: 0.99 }, 1)).toBeNull();
  });

  it.each([0.1, 8])("去抖半径按屏幕像素换算，缩放%s不改变相同可见笔迹的修复", (scale) => {
    const source = Array.from({ length: 97 }, (_, i) => p((40 * i) / (96 * scale), 0));
    const result = fitShape(
      pauseJitter(source, 1 / scale),
      { label: "line", confidence: 0.99 },
      scale,
    )!.points;
    expect(result).toHaveLength(2);
    expect(Math.hypot(result[1]!.x * scale - 40, result[1]!.y * scale)).toBeLessThan(1.5);
  });

  it.each([48, 192])("停笔采样增至%s个时，有界微抖仍不能当作大范围往返", (count) => {
    const source = Array.from({ length: 97 }, (_, i) => p((40 * i) / 96, 0));
    expect(
      fitShape(pauseJitter(source, 1, count), { label: "line", confidence: 0.99 }, 1)?.points,
    ).toHaveLength(2);
  });

  it("有序去抖保留明确角点与共线反向访问，不修改输入或端点", () => {
    const corner = [p(0, 0), p(20, 0), p(20, 20)];
    const retrace = [p(0, 0), p(20, 0), p(5, 0), p(30, 0)];
    expect(stabilizeTrace(corner, 1)).toEqual(corner);
    expect(stabilizeTrace(retrace, 1)).toEqual(retrace);
    const noisy = Array.from({ length: 31 }, (_, i) => p(i, Math.sin(i) * 0.25));
    const original = structuredClone(noisy);
    expect(stabilizeTrace(noisy, 0.5)).toEqual([noisy[0], noisy.at(-1)]);
    expect(noisy).toEqual(original);
    for (const tolerance of [-1, NaN, Infinity])
      expect(() => stabilizeTrace(noisy, tolerance)).toThrow(RangeError);
  });
});
