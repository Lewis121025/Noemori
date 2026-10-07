import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { contourDeviation } from "@reader/shared/whiteboard/fitting-math";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
function cubic(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint) {
  return Array.from({ length: 97 }, (_, i) => {
    const t = i / 96,
      u = 1 - t;
    return p(
      u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
      u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
    );
  });
}
function heart() {
  const half = [
    ...cubic(p(0, -50), p(-40, -110), p(-100, -110), p(-100, -40)),
    ...cubic(p(-100, -40), p(-100, 35), p(-45, 80), p(0, 120)).slice(1),
  ];
  return [
    ...half,
    ...half
      .slice(0, -1)
      .reverse()
      .map((q) => p(-q.x, q.y)),
  ];
}
function cloud() {
  const count = 5,
    centerRadius = 75,
    radius = 70,
    delta = Math.PI / count,
    nodeRadius =
      centerRadius * Math.cos(delta) +
      Math.sqrt(radius ** 2 - (centerRadius * Math.sin(delta)) ** 2);
  return Array.from({ length: count }, (_, i) => {
    const angle = (i * 2 * Math.PI) / count,
      cx = centerRadius * Math.cos(angle),
      cy = centerRadius * Math.sin(angle),
      start =
        angle +
        Math.atan2(-nodeRadius * Math.sin(delta), nodeRadius * Math.cos(delta) - centerRadius),
      span = 2 * (angle - start);
    return Array.from({ length: 64 }, (_, j) =>
      p(
        cx + radius * Math.cos(start + (span * j) / 64),
        cy + radius * Math.sin(start + (span * j) / 64),
      ),
    );
  }).flat();
}
function transformed(points: InkPoint[], rotation: number) {
  return points.map((q, i) => {
    const x = q.x + 0.25 * Math.sin(i * 1.7),
      y = q.y + 0.25 * Math.sin(i * 2.1);
    return p(
      500 + x * Math.cos(rotation) - y * Math.sin(rotation),
      300 + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  });
}
describe("有轮廓证据的心形与云形", () => {
  it.each([0, 0.7])("心形保持真实凹槽/尖端，两个半边镜像规范 %s", (rotation) => {
    const source = transformed(heart(), rotation),
      fit = repairShape(source, 1)!;
    expect(fit.label).toBe("heart");
    expect(fit.points[0]).toEqual(fit.points.at(-1));
    expect(contourDeviation(source, fit.points)!.rms).toBeLessThan(1.5);
  });
  it("圆弧凸瓣云形保留每个凹接点和凸瓣", () => {
    const source = cloud();
    source.push(source[0]!);
    const fit = repairShape(transformed(source, 0.3), 1)!;
    expect(fit.label).toBe("cloud");
    expect(contourDeviation(transformed(source, 0.3), fit.points)!.rms).toBeLessThan(1.5);
  });
  it("明显非镜像心形继续保形，不强制变成模板", () => {
    const source = heart().map((q) => p(q.x < 0 ? q.x * 1.5 : q.x, q.y));
    const fit = repairShape(source, 1);
    expect(fit?.label).not.toBe("heart");
    if (fit) expect(contourDeviation(source, fit.points)!.rms).toBeLessThan(3);
  });
});
