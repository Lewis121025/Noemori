import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
function shape(sweep: number, sector: boolean, rotation = 0) {
  const arc = Array.from({ length: 193 }, (_, i) =>
    p(120 * Math.cos((sweep * i) / 192), 120 * Math.sin((sweep * i) / 192)),
  );
  const vertices = sector ? [arc.at(-1)!, p(0, 0), arc[0]!] : [arc.at(-1)!, arc[0]!];
  const line = vertices
    .slice(1)
    .flatMap((b, i) =>
      Array.from({ length: 64 }, (_, j) =>
        p(
          vertices[i]!.x + ((b.x - vertices[i]!.x) * j) / 64,
          vertices[i]!.y + ((b.y - vertices[i]!.y) * j) / 64,
        ),
      ),
    );
  return [...arc, ...line, arc[0]!].map((q, i) => {
    const x = q.x + 0.3 * Math.sin(i * 1.7),
      y = q.y + 0.3 * Math.sin(i * 2.3);
    return p(
      400 + x * Math.cos(rotation) - y * Math.sin(rotation),
      300 + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  });
}
describe("共享圆心的直弧复合轮廓", () => {
  it.each([0, 0.6, 1.5])("半圆恢复圆弧与同圆直径 %s", (rotation) => {
    const source = shape(Math.PI, false, rotation),
      result = repairShape(source, 1)!;
    expect(result.label).toBe("semicircle");
    expect(result.points[0]).toEqual(result.points.at(-1));
    expect(contourDeviation(source, result.points)!.rms).toBeLessThan(1);
  });
  it.each([Math.PI / 2, Math.PI * 1.3])("扇形两条径向边共用圆心 %s", (sweep) => {
    const source = shape(sweep, true),
      result = repairShape(source, 1)!;
    expect(result.label).toBe("sector");
    expect(contourDeviation(source, result.points)!.rms).toBeLessThan(1);
  });
});
