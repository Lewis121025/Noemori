import { describe, expect, it } from "vitest";
import { repairScene } from "@reader/shared/whiteboard/fitting-scene";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const edge = (a: InkPoint, b: InkPoint) =>
  Array.from({ length: 49 }, (_, i) =>
    p(
      a.x + ((b.x - a.x) * i) / 48 + 0.3 * Math.sin(i * 1.3),
      a.y + ((b.y - a.y) * i) / 48 + 0.3 * Math.sin(i * 1.7),
    ),
  );
function request(paths: InkPoint[][]) {
  return {
    points: paths[0]!,
    observations: paths[0]!,
    scale: 1,
    context: paths.slice(1).map((points, i) => ({ id: String(i), points, observations: points })),
  };
}
describe("多笔画的拓扑与整体轮廓", () => {
  it("乱序反向的四笔矩形形成共享接点和严格直角", () => {
    const paths = [
        edge(p(200, 0), p(200, 120)),
        edge(p(0, 120), p(0, 0)),
        edge(p(200, 0), p(0, 0)),
        edge(p(200, 120), p(0, 120)),
      ],
      result = repairScene(request(paths))!;
    expect(result.label).toBe("rectangle");
    expect(result.replacements).toHaveLength(3);
    const all = [result.points, ...result.replacements!.map((s) => s.points)];
    expect(all.every((s) => s.length === 2)).toBe(true);
    for (const stroke of all)
      for (const end of [stroke[0]!, stroke.at(-1)!])
        expect(
          all
            .flatMap((s) => [s[0]!, s.at(-1)!])
            .filter((p) => Math.hypot(p.x - end.x, p.y - end.y) < 1e-7),
        ).toHaveLength(2);
    const a = result.points,
      b = result.replacements!.find((s) => s.id === "1")!.points;
    expect(
      (a[1]!.x - a[0]!.x) * (b[1]!.x - b[0]!.x) + (a[1]!.y - a[0]!.y) * (b[1]!.y - b[0]!.y),
    ).toBeCloseTo(0, 6);
  });
  it("断笔圆弧拼成一圈，每笔仍保持其原始方向", () => {
    const arc = (start: number, end: number) =>
      Array.from({ length: 97 }, (_, i) => {
        const a = start + ((end - start) * i) / 96;
        return p(100 * Math.cos(a), 100 * Math.sin(a));
      });
    const paths = [arc(0, Math.PI), arc(2 * Math.PI, Math.PI)],
      result = repairScene(request(paths))!;
    expect(result.label).toBe("circle");
    expect(result.replacements).toHaveLength(1);
    expect(result.points[0]!.x).toBeGreaterThan(90);
    expect(result.points.at(-1)!.x).toBeLessThan(-90);
    expect(result.replacements![0]!.points[0]!.x).toBeGreaterThan(90);
  });
  it("在附近但不连接的笔迹不进入修复事务", () => {
    const result = repairScene(request([edge(p(0, 0), p(200, 1)), edge(p(50, 90), p(120, 150))]));
    expect(result?.label).toBe("line");
    expect(result?.replacements).toBeUndefined();
  });
  it("T形和缺边不能按书写顺序伪造闭合矩形", () => {
    const result = repairScene(
      request([
        edge(p(0, 0), p(200, 0)),
        edge(p(100, 0), p(100, 100)),
        edge(p(0, 100), p(200, 100)),
      ]),
    );
    expect(result?.label).not.toBe("rectangle");
  });
  it("四笔轮廓的轻微接点缺口按各笔尺寸验收，恢复闭合且不改变边数", () => {
    const paths = [
        edge(p(9, 118), p(11, 2)),
        edge(p(0, 0), p(200, 1)),
        edge(p(200, 1), p(199, 120)),
        edge(p(199, 120), p(0, 119)),
      ],
      result = repairScene(request(paths))!;
    expect(result.label).toBe("rectangle");
    expect(result.replacements).toHaveLength(3);
    expect(
      [result.points, ...result.replacements!.map((s) => s.points)].every(
        (points) => points.length === 2,
      ),
    ).toBe(true);
  });
});
