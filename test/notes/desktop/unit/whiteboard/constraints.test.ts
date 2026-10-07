import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const length = (a: InkPoint, b: InkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint) =>
  (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);

/** 用独立母顶点生成手绘误差，约束断言不读取拟合器的参数化实现。 */
function outline(vertices: InkPoint[], rotation = 0): InkPoint[] {
  const closed = [...vertices, vertices[0]!];
  return closed
    .slice(1)
    .flatMap((end, i) => {
      const start = closed[i]!;
      return Array.from({ length: 48 }, (_, j) => {
        const t = j / 48,
          x = start.x + (end.x - start.x) * t + 0.4 * Math.sin(j * 1.7),
          y = start.y + (end.y - start.y) * t + 0.4 * Math.cos(j * 1.3);
        return p(
          500 + x * Math.cos(rotation) - y * Math.sin(rotation),
          300 + x * Math.sin(rotation) + y * Math.cos(rotation),
        );
      });
    })
    .concat(
      p(
        500 + vertices[0]!.x * Math.cos(rotation) - vertices[0]!.y * Math.sin(rotation),
        300 + vertices[0]!.x * Math.sin(rotation) + vertices[0]!.y * Math.cos(rotation),
      ),
    );
}

describe("多边形的等边、等角和对称约束", () => {
  it.each([0, 0.53, 1.2])("接近正方形的轮廓恢复四边等长与直角 %s", (rotation) => {
    const result = repairShape(outline([p(0, 0), p(240, 0), p(240, 237), p(0, 237)], rotation), 1)!;
    expect(result.label).toBe("rectangle");
    const points = result.points,
      lengths = points.slice(1).map((point, i) => length(points[i]!, point));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-8);
    const [a, b, c] = points;
    expect((b!.x - a!.x) * (c!.x - b!.x) + (b!.y - a!.y) * (c!.y - b!.y)).toBeCloseTo(0, 7);
  });

  it("明确长方形保留长宽差，不能为了等边改变用户轮廓", () => {
    const result = repairShape(outline([p(0, 0), p(240, 0), p(240, 130), p(0, 130)]), 1)!;
    expect(result.label).toBe("rectangle");
    expect(
      Math.abs(
        length(result.points[0]!, result.points[1]!) - length(result.points[1]!, result.points[2]!),
      ),
    ).toBeGreaterThan(100);
  });

  it("接近等边三角形恢复三条等长边", () => {
    const result = repairShape(outline([p(0, 0), p(240, 0), p(121, 207)]), 1)!;
    expect(result.label).toBe("triangle");
    const lengths = result.points.slice(1).map((point, i) => length(result.points[i]!, point));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-8);
  });

  it("等腰三角形恢复对称，两腰相等但底边可不同", () => {
    const result = repairShape(outline([p(0, 0), p(240, 0), p(121, 155)]), 1)!;
    expect(result.label).toBe("triangle");
    const lengths = result.points
      .slice(1)
      .map((point, i) => length(result.points[i]!, point))
      .sort((a, b) => a - b);
    expect(
      Math.min(Math.abs(lengths[0]! - lengths[1]!), Math.abs(lengths[1]! - lengths[2]!)),
    ).toBeLessThan(1e-8);
    expect(lengths[2]! - lengths[0]!).toBeGreaterThan(20);
  });

  it("接近直角三角形恢复一个严格直角", () => {
    const result = repairShape(outline([p(0, 0), p(240, 1), p(1, 130)]), 1)!;
    expect(result.label).toBe("triangle");
    const vertices = result.points.slice(0, -1);
    const dots = vertices.map((point, i) => {
      const a = vertices[(i + 1) % 3]!,
        b = vertices[(i + 2) % 3]!;
      return Math.abs((a.x - point.x) * (b.x - point.x) + (a.y - point.y) * (b.y - point.y));
    });
    expect(Math.min(...dots)).toBeLessThan(1e-7);
  });

  it("接近平行四边形恢复两组对边平行，保持倾斜角", () => {
    const result = repairShape(outline([p(0, 0), p(240, 0), p(303, 150), p(62, 150)]), 1)!;
    expect(result.label).toBe("polygon");
    const [a, b, c, d] = result.points;
    expect(cross(a!, b!, c!, d!)).toBeCloseTo(0, 7);
    expect(cross(b!, c!, d!, a!)).toBeCloseTo(0, 7);
    expect(Math.abs((b!.x - a!.x) * (c!.x - b!.x) + (b!.y - a!.y) * (c!.y - b!.y))).toBeGreaterThan(
      10000,
    );
  });

  it("菱形恢复等边，避免误修成具有直角的矩形", () => {
    const result = repairShape(outline([p(0, -80), p(150, 0), p(1, 81), p(-150, 0)]), 1)!;
    expect(result.label).toBe("polygon");
    const lengths = result.points.slice(1).map((point, i) => length(result.points[i]!, point));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-8);
  });

  it("梯形只恢复成立的一组对边平行，不强制补成平行四边形", () => {
    const result = repairShape(outline([p(30, 0), p(190, 1), p(245, 150), p(0, 150)]), 1)!;
    expect(result.label).toBe("polygon");
    const [a, b, c, d] = result.points;
    expect(Math.min(Math.abs(cross(a!, b!, c!, d!)), Math.abs(cross(b!, c!, d!, a!)))).toBeLessThan(
      1e-7,
    );
    const difference =
      Math.abs(cross(a!, b!, c!, d!)) < Math.abs(cross(b!, c!, d!, a!))
        ? Math.abs(length(a!, b!) - length(c!, d!))
        : Math.abs(length(b!, c!) - length(d!, a!));
    expect(difference).toBeGreaterThan(70);
  });

  it.each([5, 6, 8])("正%s边形恢复等边等角，而非任意不等边多边形", (count) => {
    const vertices = Array.from({ length: count }, (_, i) => {
      const angle = (i * 2 * Math.PI) / count,
        radius = 110 + (i === 2 ? 1 : 0);
      return p(radius * Math.cos(angle), radius * Math.sin(angle));
    });
    const result = repairShape(outline(vertices), 1)!;
    expect(result.label).toBe("polygon");
    expect(result.points).toHaveLength(count + 1);
    const lengths = result.points.slice(1).map((point, i) => length(result.points[i]!, point));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-8);
  });

  it.each([12, 16])("有明确直边的近圆%s边形保留边数，不能按低自由度磨成圆", (count) => {
    const vertices = Array.from({ length: count }, (_, i) =>
      p(120 * Math.cos((i * 2 * Math.PI) / count), 120 * Math.sin((i * 2 * Math.PI) / count)),
    );
    const points = vertices.flatMap((a, i) => {
      const b = vertices[(i + 1) % count]!;
      return Array.from({ length: 40 }, (_, j) =>
        p(a.x + ((b.x - a.x) * j) / 40, a.y + ((b.y - a.y) * j) / 40),
      );
    });
    points.push(points[0]!);
    const result = repairShape(points, 1, points)!;
    expect(result.label).toBe("polygon");
    expect(result.points).toHaveLength(count + 1);
    for (const point of vertices)
      expect(result.points.some((other) => length(point, other) < 0.1)).toBe(true);
  });

  it("外轮廓五角星恢复交替半径和对称结构", () => {
    const vertices = Array.from({ length: 10 }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5,
        radius = (i % 2 === 0 ? 110 : 48) + (i === 2 ? 1 : 0);
      return p(radius * Math.cos(angle), radius * Math.sin(angle));
    });
    const result = repairShape(outline(vertices), 1)!;
    expect(result.label).toBe("star");
    expect(result.points).toHaveLength(11);
    const points = result.points.slice(0, -1),
      center = p(
        points.reduce((sum, p) => sum + p.x, 0) / 10,
        points.reduce((sum, p) => sum + p.y, 0) / 10,
      );
    for (const parity of [0, 1]) {
      const radii = points.filter((_, i) => i % 2 === parity).map((point) => length(point, center));
      expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-8);
    }
  });
});
