import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import { BOARD_COORDINATE_LIMIT, type InkPoint } from "@reader/shared/whiteboard/model";
import { angleAdvance, traceAdvance } from "@reader/shared/whiteboard/fitting-math";
import {
  parseRecognitionPoints,
  parseShapeFit,
  type ShapeLabel,
} from "@reader/shared/whiteboard/recognition";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.6 });
const fit = (points: InkPoint[], label: ShapeLabel, scale = 1) => {
  const result = repairShape(points, scale);
  return result?.label === label ? result.points : null;
};
const contour = (rx: number, ry: number, sweep = Math.PI * 2, rotation = 0) =>
  Array.from({ length: 129 }, (_, i) => {
    const angle = (i * sweep) / 128;
    const jitter = i === 0 || i === 128 ? 0 : Math.sin(i * 3) * 0.5;
    const x = rx * Math.cos(angle) + jitter,
      y = ry * Math.sin(angle) + jitter;
    return p(
      700 + x * Math.cos(rotation) - y * Math.sin(rotation),
      -350 + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  });
function polygon(vertices: InkPoint[]): InkPoint[] {
  return vertices
    .slice(1)
    .flatMap((end, i) =>
      Array.from({ length: 32 }, (_, j) => {
        const t = j / 32,
          start = vertices[i]!;
        const noise = Math.sin(j * 2) * 0.5;
        return p(start.x + (end.x - start.x) * t + noise, start.y + (end.y - start.y) * t + noise);
      }),
    )
    .concat(vertices.at(-1)!);
}

/** 空间连续的有界抖动；同一个角点回访时偏移相同，避免把箭尖拆成不同位置。 */
function noisyPolygon(vertices: InkPoint[], phase: number, rotation: number): InkPoint[] {
  const points = vertices.slice(1).flatMap((end, i) => {
    const start = vertices[i]!;
    const count = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2);
    return Array.from({ length: count }, (_, j) =>
      p(start.x + ((end.x - start.x) * j) / count, start.y + ((end.y - start.y) * j) / count),
    );
  });
  return [...points, vertices.at(-1)!].map((point) => {
    const x = point.x * Math.cos(rotation) - point.y * Math.sin(rotation),
      y = point.x * Math.sin(rotation) + point.y * Math.cos(rotation);
    const u = x / 200,
      v = y / 200;
    return p(
      x + (6 / Math.sqrt(2)) * Math.sin(2 * Math.PI * (11 * u + 7 * v) + phase),
      y + (6 / Math.sqrt(2)) * Math.sin(2 * Math.PI * (9 * u - 8 * v) - phase),
    );
  });
}

describe("轨迹结构的几何拟合与拒绝条件", () => {
  it("停笔归并不能隐藏超出最大偏差的观测，原始抖动不再按往返弧长重复加权", () => {
    const staticLine = [p(0, 0), p(40, 0)];
    const observations = [
      ...staticLine,
      ...Array.from({ length: 200 }, (_, i) => p(40, 2.9 * Math.sin(i * 1.7))),
    ];
    expect(repairShape(staticLine, 1, observations)?.points).toHaveLength(2);
    expect(repairShape(staticLine, 1, [...observations, p(40, 3.1)])).toBeNull();
    expect(repairShape(staticLine, 1, [...observations, p(1000, 0)])).toBeNull();
    expect(repairShape(staticLine, 1, [...observations, p(NaN, 0)])).toBeNull();
  });
  it("局部回描预算按净推进计算，方向翻转和圆周跨接缝不改变判据", () => {
    expect(traceAdvance([0.6, -0.125, 0.525])).toBeCloseTo(1);
    expect(traceAdvance([-0.6, 0.125, -0.525])).toBeCloseTo(-1);
    expect(traceAdvance([0.6, -0.13, 0.53])).toBeNull();
    expect(traceAdvance([1, -1])).toBeNull();
    expect(traceAdvance([NaN])).toBeNull();
    expect(angleAdvance([3.1, -3.1, -3, -2.9])).toBeCloseTo(2 * Math.PI - 6);
  });
  it("直线用向量拟合保留位置、方向与长度，拒绝折线和来回涂划", () => {
    const points = Array.from({ length: 100 }, (_, i) =>
      p(50 + i, 200 + i * 0.7 + Math.sin(i) * 0.6),
    );
    const result = fit(points, "line")!;
    expect(result).toHaveLength(2);
    expect(result[0]!.x).toBeCloseTo(50, 0);
    expect(result[1]!.x).toBeCloseTo(149, 0);
    expect((result[1]!.y - result[0]!.y) / (result[1]!.x - result[0]!.x)).toBeCloseTo(0.7, 2);
    expect(fit([p(0, 0), p(80, 50), p(160, 0)], "line")).toBeNull();
    expect(fit([p(0, 0), p(100, 0), p(0, 0), p(100, 0)], "line")).toBeNull();
  });
  it("密集横向推进的笔尖抖动仍可修直，横向折返保持原笔迹", () => {
    const dense = Array.from({ length: 501 }, (_, i) => p(i * 0.2, Math.sin(i * 1.7) * 0.6));
    expect(fit(dense, "line")).toHaveLength(2);
    expect(fit([p(0, 0), p(100, 0.1), p(0, -0.1), p(100, 0)], "line")).toBeNull();
  });
  it("抖动圆恢复恒定半径，闭合椭圆保留长短轴并拒绝半圆或重复描圈", () => {
    const result = fit(contour(80, 80), "circle")!;
    expect(result).toHaveLength(129);
    expect(result.at(-1)).toEqual(result[0]);
    const radii = result.map((point) => Math.hypot(point.x - 700, point.y + 350));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.1);
    expect(repairShape(contour(100, 50), 1)?.label).toBe("ellipse");
    expect(fit(contour(80, 80, Math.PI), "circle")).toBeNull();
    expect(fit(contour(80, 80, Math.PI * 4), "circle")).toBeNull();
  });
  it.each([0, 0.63, 1.5])("椭圆保留长短轴和旋转方向 %s", (rotation) => {
    const result = fit(contour(100, 45, Math.PI * 2, rotation), "ellipse")!;
    expect(result).toHaveLength(129);
    const radii = result.map((point) => Math.hypot(point.x - 700, point.y + 350));
    expect(Math.max(...radii)).toBeCloseTo(100, 0);
    expect(Math.min(...radii)).toBeCloseTo(45, 0);
  });
  it("圆弧保留开口和扫过方向，不自动封口", () => {
    const result = fit(contour(80, 80, Math.PI * 1.4), "arc")!;
    expect(result).toHaveLength(129);
    expect(
      Math.hypot(result[0]!.x - result.at(-1)!.x, result[0]!.y - result.at(-1)!.y),
    ).toBeGreaterThan(100);
    expect(fit(contour(80, 80), "arc")).toBeNull();
  });
  it.each([0, 0.37, 1.1])("矩形和正方形恢复直角，支持旋转 %s", (angle) => {
    for (const height of [50, 100]) {
      const points = polygon([p(0, 0), p(100, 0), p(100, height), p(0, height), p(0, 0)]).map(
        (point) =>
          p(
            point.x * Math.cos(angle) - point.y * Math.sin(angle),
            point.x * Math.sin(angle) + point.y * Math.cos(angle),
          ),
      );
      const result = fit(points, "rectangle")!;
      expect(result).toHaveLength(5);
      const [a, b, c] = result;
      expect((b!.x - a!.x) * (c!.x - b!.x) + (b!.y - a!.y) * (c!.y - b!.y)).toBeCloseTo(0, 8);
    }
    expect(fit(polygon([p(0, 0), p(100, 0), p(100, 100), p(0, 100)]), "rectangle")).toBeNull();
  });
  it("三角形从边中间起笔仍只产生三条直边，不把矩形解释为三角形", () => {
    const points = polygon([p(50, 0), p(100, 0), p(50, 100), p(0, 0), p(50, 0)]);
    const result = fit(points, "triangle")!;
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(result.at(-1));
    expect(
      fit(polygon([p(0, 0), p(100, 0), p(100, 100), p(0, 100), p(0, 0)]), "triangle"),
    ).toBeNull();
  });
  it("连续箭头恢复对称箭翼，拒绝缺少一翼的形状", () => {
    const points = polygon([p(0, 0), p(100, 0), p(75, 20), p(100, 0), p(74, -18)]);
    const result = fit(points, "arrow")!;
    expect(result).toHaveLength(5);
    expect(fit([...points].reverse(), "arrow")).toHaveLength(5);
    expect(
      fit(polygon([p(75, 20), p(100, 0), p(0, 0), p(100, 0), p(74, -18)]), "arrow"),
    ).toHaveLength(5);
    const [start, tip, left, , right] = result;
    const dx = tip!.x - start!.x,
      dy = tip!.y - start!.y;
    const along = (point: InkPoint) => (point.x - tip!.x) * dx + (point.y - tip!.y) * dy;
    const across = (point: InkPoint) => (point.x - tip!.x) * dy - (point.y - tip!.y) * dx;
    expect(along(left!)).toBeCloseTo(along(right!), 8);
    expect(across(left!)).toBeCloseTo(-across(right!), 8);
    expect(fit(points.slice(0, 70), "arrow")).toBeNull();
  });
  it("缩放只影响最小屏幕尺寸，世界坐标平移和大坐标不会破坏拟合", () => {
    const points = [p(0, 0), p(10, 0.1), p(20, 0)];
    expect(fit(points, "line", 0.5)).toBeNull();
    expect(fit(points, "line", 2)).toHaveLength(2);
    expect(
      fit(
        points.map((point) => p(point.x + 9_000_000, point.y - 8_000_000)),
        "line",
      ),
    ).toHaveLength(2);
    const edge = contour(80, 80).map((point) =>
      p(point.x - 700 + BOARD_COORDINATE_LIMIT - 79.9, point.y),
    );
    expect(fit(edge, "circle")).toBeNull();
  });
  it("非法输入与修复协议严格拒绝，不存在模型分数门槛", () => {
    const points = [p(0, 0), p(100, 0)];
    expect(repairShape(points, 1)?.label).toBe("line");
    for (const value of [
      {},
      { label: "square", points },
      { label: "line", points: [p(NaN, 0), p(1, 0)] },
    ])
      expect(() => parseShapeFit(value)).toThrow();
    expect(parseShapeFit(null)).toBeNull();
    expect(() => parseRecognitionPoints([p(0, 0), p(Infinity, 1)])).toThrow();
    expect(() => parseRecognitionPoints(Array.from({ length: 8193 }, () => p(1, 2)))).toThrow();
    expect(parseShapeFit({ label: "line", points })).toEqual({ label: "line", points });
  });
  it("规则四边形从几何恢复直角，不依赖分类类别", () => {
    expect(
      repairShape(polygon([p(0, 0), p(250, 0), p(250, 240), p(0, 240), p(0, 0)]), 1)?.label,
    ).toBe("rectangle");
  });

  it("局部回描保持完整轮廓时可修复，不能把大范围折返或重复整圈当成局部误差", () => {
    const retrace = (points: InkPoint[], at: number, count: number) => [
      ...points.slice(0, at + 1),
      ...points.slice(at - count, at).reverse(),
      ...points.slice(at - count + 1),
    ];
    const cases: [ShapeLabel, InkPoint[], number][] = [
      ["line", Array.from({ length: 101 }, (_, i) => p(i * 2, 0)), 70],
      ["circle", contour(100, 100), 70],
      ["ellipse", contour(110, 60), 70],
      ["arc", contour(100, 100, Math.PI * 1.5), 70],
      ["triangle", polygon([p(0, 0), p(200, 0), p(100, 170), p(0, 0)]), 65],
      ["arrow", polygon([p(0, 0), p(200, 0), p(150, 40), p(200, 0), p(150, -40)]), 65],
    ];
    for (const [label, points, at] of cases) {
      expect(fit(points, label), `${label}干净母图`).not.toBeNull();
      expect(fit(retrace(points, at, 10), label), `${label}局部回描`).not.toBeNull();
      expect(fit(retrace(points, at, 38), label), `${label}大范围折返`).toBeNull();
    }
    expect(fit(contour(100, 100, Math.PI * 4), "circle")).toBeNull();
    const triangle = cases[4]![1];
    expect(fit([...triangle, ...triangle.slice(1)], "triangle")).toBeNull();
  });

  it("跨三角形角点的局部回描不应因同一顶点出现多次而被拒绝", () => {
    const size = 234.797381372,
      height = size * 0.777178443,
      apex = size * 0.259698438,
      angle = (80.612291697 * Math.PI) / 180;
    const vertices = [
      p(-size / 2, height / 3),
      p(size / 2, height / 3),
      p(apex, (-2 * height) / 3),
      p(-size / 2, height / 3),
    ];
    const source = [vertices[0]!];
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1]!,
        b = vertices[i]!;
      const count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (size / 96));
      for (let j = 1; j <= count; j++)
        source.push(p(a.x + ((b.x - a.x) * j) / count, a.y + ((b.y - a.y) * j) / count));
    }
    const points = source.map((point) =>
      p(
        point.x * Math.cos(angle) - point.y * Math.sin(angle),
        point.x * Math.sin(angle) + point.y * Math.cos(angle),
      ),
    );
    const start = Math.round((points.length - 1) * 0.24),
      end = start + Math.round((points.length - 1) * 0.12);
    const retraced = [
      ...points.slice(0, end + 1),
      ...points.slice(start, end).reverse(),
      ...points.slice(start + 1),
    ];
    expect(fit(points, "triangle")).toHaveLength(4);
    expect(fit(retraced, "triangle")).toHaveLength(4);
    expect(fit([...retraced].reverse(), "triangle")).toHaveLength(4);
  });

  const noisyShapes: [ShapeLabel, InkPoint[], number][] = [
    ["triangle", [p(0, 0), p(200, 0), p(130, 160), p(0, 0)], 4],
    ["arrow", [p(0, 0), p(200, 0), p(145, 40), p(200, 0), p(145, -40)], 5],
  ];
  // 每种形状、旋转和相位独立断言，避免把十二次昂贵拟合捆进一个测试时限。
  const noisyCases = [0, 0.37, 1.1].flatMap((rotation) =>
    noisyShapes.flatMap(([label, vertices, count]) =>
      [0, 0.7, 2.1].map((phase) => ({ rotation, label, vertices, count, phase })),
    ),
  );
  it.each(noisyCases)(
    "有界强抖动不应把边上波纹当成额外角点：$label / 旋转 $rotation / 相位 $phase",
    ({ rotation, label, vertices, count, phase }) => {
      const points = noisyPolygon(vertices, phase, rotation);
      const result = fit(points, label)!;
      expect(result, `${label}/${phase}`).toHaveLength(count);
      expect(fit([...points].reverse(), label), `${label}/${phase}/反向`).toHaveLength(count);
      for (const vertex of vertices) {
        const x = vertex.x * Math.cos(rotation) - vertex.y * Math.sin(rotation),
          y = vertex.x * Math.sin(rotation) + vertex.y * Math.cos(rotation);
        expect(
          Math.min(...result.map((point) => Math.hypot(point.x - x, point.y - y))),
        ).toBeLessThan(12);
      }
    },
  );

  it("固定角点数只生成候选，额外折线、非三角闭合轮廓和内部涂划仍须拒绝", () => {
    for (const points of [
      contour(100, 100),
      polygon([p(0, 0), p(200, 0), p(230, 100), p(120, 190), p(-30, 100), p(0, 0)]),
      polygon([p(0, 0), p(200, 0), p(100, 170), p(0, 0), p(110, 65), p(0, 0)]),
    ])
      expect(fit(points, "triangle")).toBeNull();
    for (const vertices of [
      [p(0, 0), p(70, 60), p(140, -60), p(200, 0), p(145, 40), p(200, 0), p(145, -40)],
      [p(0, 0), p(200, 0), p(145, 40), p(200, 0), p(145, -40), p(80, -110)],
      [p(0, 0), p(200, 0), p(145, 40)],
    ])
      expect(fit(polygon(vertices), "arrow")).toBeNull();
  });
});
