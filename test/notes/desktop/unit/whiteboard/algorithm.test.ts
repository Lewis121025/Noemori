import { describe, expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });

/** 同一角点数下改变大小、方向、曲率及手抖，检查几何结构而非某张截图的像素位置。 */
function path(vertices: InkPoint[], bow = 0, noise = 0): InkPoint[] {
  const result = vertices.slice(1).flatMap((end, i) => {
    const start = vertices[i]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return Array.from({ length: 60 }, (_, j) => {
      const t = j / 60;
      const offset = bow * Math.sin(Math.PI * t) + noise * Math.sin(j * 1.7);
      return p(
        start.x + (end.x - start.x) * t - (offset * (end.y - start.y)) / length,
        start.y + (end.y - start.y) * t + (offset * (end.x - start.x)) / length,
      );
    });
  });
  return [...result, vertices.at(-1)!];
}

function oval(ratio: number): InkPoint[] {
  return Array.from({ length: 193 }, (_, i) => {
    const angle = (i * 2 * Math.PI) / 192;
    return p(100 * Math.cos(angle), 100 * ratio * Math.sin(angle));
  });
}

describe("不依赖分类模型的整体几何修复", () => {
  it("直接从轨迹修直线，短尾巴与有界抖动不阻断修复", () => {
    const points = [...path([p(0, 0), p(200, 0)], 3, 2), p(202, 3), p(199, 5)];
    const result = repairShape(points, 1);
    expect(result?.label).toBe("line");
    expect(result!.points).toHaveLength(2);
    expect(result!.points[1]!.x - result!.points[0]!.x).toBeGreaterThan(190);
  });
  it.each([0, 0.7, 1.9])("弯曲边和手抖保留三角形的整体结构，旋转 %s", (rotation) => {
    const points = path([p(0, 0), p(240, 0), p(70, 200), p(0, 0)], 15, 3).map((point) =>
      p(
        point.x * Math.cos(rotation) - point.y * Math.sin(rotation),
        point.x * Math.sin(rotation) + point.y * Math.cos(rotation),
      ),
    );
    const result = repairShape(points, 1);
    expect(result?.label).toBe("triangle");
    expect(result!.points).toHaveLength(4);
    expect(result!.points[0]).toEqual(result!.points.at(-1));
  });
  it.each([3, 4, 5, 6, 8])("同一角点与边段算法修复 %s 边形", (count) => {
    const vertices = Array.from({ length: count }, (_, i) =>
      p(100 * Math.cos((i * 2 * Math.PI) / count), 100 * Math.sin((i * 2 * Math.PI) / count)),
    );
    const result = repairShape(path([...vertices, vertices[0]!], 2, 1), 1);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(count + 1);
    expect(result!.points.at(-1)).toEqual(result!.points[0]);
  });
  it.each([5, 7])("自交星形依靠有序边段与绕数修复，顶点数 %s", (count) => {
    const vertices = Array.from({ length: count }, (_, i) => {
      const angle = (i * 4 * Math.PI) / count;
      return p(100 * Math.cos(angle), 120 * Math.sin(angle));
    });
    const result = repairShape(path([...vertices, vertices[0]!], 3, 2), 1);
    expect(result?.label).toBe("star");
    expect(result!.points).toHaveLength(count + 1);
  });
  it("近圆多边形的真实角点不能被平滑圆抹掉，即使边段有弯曲", () => {
    const vertices = Array.from({ length: 8 }, (_, i) =>
      p(100 * Math.cos((i * Math.PI) / 4), 100 * Math.sin((i * Math.PI) / 4)),
    );
    const result = repairShape(path([...vertices, vertices[0]!], 8, 4), 1);
    expect(result?.label).toBe("polygon");
    expect(result!.points).toHaveLength(9);
  });
  it.each([0, 0.7, 1.9])("箭头分支可有边弯曲，但不能补出缺失的翼或隐藏多余回描 %s", (rotation) => {
    const vertices = [p(0, 0), p(200, 0), p(150, 36), p(200, 0), p(150, -36)].map((point) =>
      p(
        point.x * Math.cos(rotation) - point.y * Math.sin(rotation),
        point.x * Math.sin(rotation) + point.y * Math.cos(rotation),
      ),
    );
    expect(repairShape(path(vertices, 8, 4), 1)?.label).toBe("arrow");
    expect(repairShape(path(vertices.slice(0, 3), 8, 4), 1)?.label).not.toBe("arrow");
    const retraced = [...vertices.slice(0, 2), vertices[0]!, ...vertices.slice(1)];
    expect(repairShape(path(retraced, 8, 4), 1)).toBeNull();
  });
  it("圆、明确椭圆和近圆边界由几何确定", () => {
    expect(repairShape(oval(1), 1)?.label).toBe("circle");
    expect(repairShape(oval(0.7), 1)?.label).toBe("ellipse");
    expect(repairShape(oval(0.98), 1)?.label).toBe("circle");
  });
  it("自由曲线保形拟合，重复描圈和额外笔画仍须拒绝，原始观测不能被隐藏", () => {
    const curve = Array.from({ length: 193 }, (_, i) => p(i, 70 * Math.sin(i / 28)));
    expect(repairShape(curve, 1)?.label).toBe("curve");
    const circle = oval(1);
    expect(repairShape([...circle, ...circle.slice(1)], 1)).toBeNull();
    expect(repairShape(circle, 1, [...circle, p(0, 0)])).toBeNull();
  });
});
