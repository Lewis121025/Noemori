import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { repairScene } from "@reader/shared/whiteboard/fitting-scene";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const edge = (a: InkPoint, b: InkPoint) =>
  Array.from({ length: 49 }, (_, i) =>
    p(
      a.x + ((b.x - a.x) * i) / 48 + 0.2 * Math.sin(i * 1.3),
      a.y + ((b.y - a.y) * i) / 48 + 0.2 * Math.sin(i * 1.7),
    ),
  );
const polygon = (vertices: InkPoint[]) =>
  vertices.slice(1).flatMap((b, i) => edge(vertices[i]!, b));
function scene(paths: InkPoint[][]) {
  return repairScene({
    points: paths[0]!,
    observations: paths[0]!,
    scale: 1,
    context: paths.slice(1).map((points, i) => ({ id: String(i), points, observations: points })),
  });
}
describe("补充的复合几何", () => {
  it.each([false, true])("闭合轮廓箭头恢复中轴对称 %s", (double) => {
    const vertices = double
      ? [
          p(-180, 0),
          p(-120, -60),
          p(-120, -24),
          p(120, -24),
          p(120, -60),
          p(180, 0),
          p(120, 60),
          p(120, 24),
          p(-120, 24),
          p(-120, 60),
        ]
      : [p(-180, -24), p(90, -24), p(90, -60), p(180, 0), p(90, 60), p(90, 24), p(-180, 24)];
    const result = repairShape(polygon([...vertices, vertices[0]!]), 1)!;
    expect(result.label).toBe("arrow");
    expect(result.points).toHaveLength(vertices.length + 1);
    expect(result.points[0]).toEqual(result.points.at(-1));
  });
  it("三笔箭头的两翼围绕主干切线对称", () => {
    const result = scene([
      edge(p(160, -35), p(220, 0)),
      edge(p(0, 0), p(220, 0)),
      edge(p(220, 0), p(160, 36)),
    ])!;
    expect(result.label).toBe("arrow");
    expect(result.replacements).toHaveLength(2);
  });
  it("两笔V头和主干共享连接点", () => {
    const result = scene([
      polygon([p(160, -35), p(220, 0), p(160, 36)]),
      edge(p(0, 0), p(220, 0)),
    ])!;
    expect(result.label).toBe("arrow");
    expect(result.replacements).toHaveLength(1);
  });
  it("双箭头两端分别依据各自切线修复", () => {
    const result = scene([
      edge(p(60, 35), p(0, 0)),
      edge(p(0, 0), p(220, 0)),
      edge(p(0, 0), p(60, -36)),
      edge(p(160, -35), p(220, 0)),
      edge(p(220, 0), p(160, 36)),
    ])!;
    expect(result.label).toBe("arrow");
    expect(result.replacements).toHaveLength(4);
  });
  it("弯曲主干以端点切线确定箭翼，曲率不被修成直线", () => {
    const shaft = Array.from({ length: 193 }, (_, i) => {
        const a = -Math.PI / 2 + (Math.PI * i) / 192;
        return p(100 * Math.cos(a), 100 * Math.sin(a));
      }),
      tip = shaft.at(-1)!,
      result = scene([edge(p(40, 75), tip), shaft, edge(tip, p(40, 125))])!;
    expect(result.label).toBe("arrow");
    expect(result.replacements!.find((s) => s.id === "0")!.points.length).toBeGreaterThan(16);
  });
  it("缺翼主干不能伪造箭头", () => {
    expect(scene([edge(p(160, -35), p(220, 0)), edge(p(0, 0), p(220, 0))])?.label).not.toBe(
      "arrow",
    );
  });
  it.each([false, true])("圆柱共用截面参数、相切侧边，底圈可只露半圈 %s", (half) => {
    const ellipse = (cy: number, sweep: number) =>
      Array.from({ length: 193 }, (_, i) => {
        const a = (sweep * i) / 192;
        return p(100 * Math.cos(a), cy + 35 * Math.sin(a));
      });
    const paths = [
        edge(p(100, 0), p(100, 160)),
        ellipse(0, 2 * Math.PI),
        edge(p(-100, 0), p(-100, 160)),
        ellipse(160, half ? Math.PI : 2 * Math.PI),
      ],
      result = scene(paths)!;
    expect(result.label).toBe("cylinder");
    expect(result.replacements).toHaveLength(3);
    for (const replacement of result.replacements!)
      expect(
        contourDeviation(paths[Number(replacement.id) + 1]!, replacement.points)!.rms,
      ).toBeLessThan(0.7);
  });
  it.each([3, 5, 6])("圆角正%s边形恢复等半径圆角与相切边", (count) => {
    const radius = 120,
      fillet = 24,
      inner = radius - fillet / Math.cos(Math.PI / count),
      arcs = Array.from({ length: count }, (_, i) => {
        const angle = (i * 2 * Math.PI) / count;
        return Array.from({ length: 33 }, (_, j) =>
          p(
            inner * Math.cos(angle) +
              fillet * Math.cos(angle - Math.PI / count + (j * 2 * Math.PI) / (32 * count)),
            inner * Math.sin(angle) +
              fillet * Math.sin(angle - Math.PI / count + (j * 2 * Math.PI) / (32 * count)),
          ),
        );
      });
    const source = arcs.flatMap((arc, i) => [
      ...arc,
      ...edge(arc.at(-1)!, arcs[(i + 1) % count]![0]!).slice(1),
    ]);
    source.push(source[0]!);
    const result = repairShape(source, 1)!;
    expect(result.label).toBe("rounded-polygon");
    expect(contourDeviation(source, result.points)!.rms).toBeLessThan(0.8);
  });
  it.each([0, 0.7])("一般圆角梯形保留不等边长度与共同圆角 %s", (rotation) => {
    const r = 20,
      offset = (20 * Math.sqrt(241)) / 15,
      top = offset + 80 / 15,
      bottom = offset + 520 / 15,
      tilt = Math.atan(4 / 15),
      corners = [
        [240 - top, 20, -Math.PI / 2, tilt],
        [240 - bottom, 130, tilt, Math.PI / 2],
        [bottom, 130, Math.PI / 2, Math.PI - tilt],
        [top, 20, Math.PI - tilt, (3 * Math.PI) / 2],
      ],
      arcs = corners.map(([x, y, start, end]) =>
        Array.from({ length: 65 }, (_, i) =>
          p(
            x! + r * Math.cos(start! + ((end! - start!) * i) / 64),
            y! + r * Math.sin(start! + ((end! - start!) * i) / 64),
          ),
        ),
      );
    const source = arcs.flatMap((arc, i) => [
      ...arc,
      ...edge(arc.at(-1)!, arcs[(i + 1) % arcs.length]![0]!).slice(1),
    ]);
    source.push(source[0]!);
    const rotated = source.map((q) =>
        p(
          q.x * Math.cos(rotation) - q.y * Math.sin(rotation),
          q.x * Math.sin(rotation) + q.y * Math.cos(rotation),
        ),
      ),
      fit = repairShape(rotated, 1)!;
    expect(fit.label).toBe("rounded-polygon");
    expect(contourDeviation(rotated, fit.points)!.rms).toBeLessThan(0.8);
  });
});
