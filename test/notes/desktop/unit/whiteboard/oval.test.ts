import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import type { InkPoint } from "@reader/shared/whiteboard/model";
function contour(ratio: number, rotation = 0, scale = 1): InkPoint[] {
  return Array.from({ length: 193 }, (_, i) => {
    const angle = (i * 2 * Math.PI) / 192;
    const noise = i === 0 || i === 192 ? 0 : Math.sin(i * 2.3) * 0.4;
    const x = 100 * Math.cos(angle) + noise;
    const y = 100 * ratio * Math.sin(angle) + noise;
    return {
      x: (600 + x * Math.cos(rotation) - y * Math.sin(rotation)) / scale,
      y: (-300 + x * Math.sin(rotation) + y * Math.cos(rotation)) / scale,
      pressure: 0.5,
    };
  });
}

describe("圆椭圆的几何边界", () => {
  it.each([0, 0.43, 1.2])("明显椭圆保留长短轴与方向 %s", (rotation) => {
    const result = repairShape(contour(0.72, rotation), 1);
    expect(result?.label).toBe("ellipse");
    const radii = result!.points.map((p) => Math.hypot(p.x - 600, p.y + 300));
    expect(Math.max(...radii)).toBeCloseTo(100, 0);
    expect(Math.min(...radii)).toBeCloseTo(72, 0);
  });
  it.each([0.5, 1, 2])("近等轴圆在相同可见缩放中保持恒定半径 %s", (scale) => {
    const result = repairShape(contour(1, 0.4, scale), scale);
    expect(result?.label).toBe("circle");
    const radii = result!.points.map((p) => Math.hypot(p.x - 600 / scale, p.y + 300 / scale));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.1 / scale);
  });
  it("轴差落在位置不确定性内时使用圆，否则保留长短轴", () => {
    expect(repairShape(contour(0.98, 0.6), 1)?.label).toBe("circle");
    expect(repairShape(contour(0.8, 0.6), 1)?.label).toBe("ellipse");
  });
  it("半圈、重复整圈和内部额外笔画不能补成完整圆或椭圆", () => {
    const points = contour(0.72);
    const half = repairShape(points.slice(0, 97), 1);
    expect(half?.label).not.toBe("circle");
    expect(half?.label).not.toBe("ellipse");
    expect(repairShape([...points, ...points.slice(1)], 1)).toBeNull();
    expect(repairShape([...points, { x: 600, y: -300, pressure: 0.5 }, points[0]!], 1)).toBeNull();
  });
});
