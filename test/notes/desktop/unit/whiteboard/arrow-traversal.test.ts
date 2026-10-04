import { describe, expect, it } from "vitest";
import { fitShape } from "@reader/shared/whiteboard/fitting";
import type { InkPoint } from "@reader/shared/whiteboard/model";

const nodes = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 145, y: -40 },
  { x: 145, y: 40 },
] as const;

/** 三分支箭头的连续遍历；空间抖动只改变轮廓，不改变分支和回访位置。 */
function route(indices: readonly number[], rotation: number): InkPoint[] {
  const vertices = indices.map((index) => nodes[index]!);
  const points = vertices.slice(1).flatMap((end, i) => {
    const start = vertices[i]!;
    const count = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2);
    return Array.from({ length: count }, (_, j) => ({
      x: start.x + ((end.x - start.x) * j) / count,
      y: start.y + ((end.y - start.y) * j) / count,
    }));
  });
  return [...points, vertices.at(-1)!].map((point) => {
    const x = point.x + Math.sin(point.x * 0.27 + point.y * 0.11) * 0.5,
      y = point.y + Math.sin(point.x * 0.13 - point.y * 0.31) * 0.5;
    return {
      x: x * Math.cos(rotation) - y * Math.sin(rotation),
      y: x * Math.sin(rotation) + y * Math.cos(rotation),
      pressure: 0.6,
    };
  });
}

describe("单笔箭头的轮廓与分支遍历", () => {
  it.each([0, 0.41, 1.7])("起笔分支、分支顺序和收笔位置不改变箭头结构 %s", (rotation) => {
    const routes = [
      [0, 1, 2, 1, 3],
      [0, 1, 2, 1, 3, 1],
      [2, 1, 0, 1, 3],
      [1, 2, 1, 0, 1, 3, 1],
      [0, 1, 3, 1, 2, 1, 0],
    ];
    for (const indices of routes)
      for (const order of [indices, [...indices].reverse()]) {
        const fitted = fitShape(route(order, rotation), { label: "arrow", confidence: 0.99 }, 1)!;
        expect(fitted, order.join("→")).toHaveLength(5);
        for (const node of nodes) {
          const x = node.x * Math.cos(rotation) - node.y * Math.sin(rotation),
            y = node.x * Math.sin(rotation) + node.y * Math.cos(rotation);
          expect(
            Math.min(...fitted.map((point) => Math.hypot(point.x - x, point.y - y))),
          ).toBeLessThan(3);
        }
      }
  });

  it("分支必要回程不当作涂划，超出覆盖需要的反复描画仍须拒绝", () => {
    for (const indices of [
      [0, 1, 0, 1, 0, 1, 2, 1, 3],
      [0, 1, 2, 1, 2, 1, 2, 1, 3],
      [0, 1, 3, 1, 3, 1, 3, 1, 2],
    ])
      expect(fitShape(route(indices, 0), { label: "arrow", confidence: 0.99 }, 1)).toBeNull();
  });
});
