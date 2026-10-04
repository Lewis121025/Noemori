import { describe, expect, it } from "vitest";
import { erasedStrokes, toWorld, zoomAt } from "@reader/shared/whiteboard/geometry";
import type { InkPoint, InkStroke } from "@reader/shared/whiteboard/model";

const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const line: InkStroke = { id: "inside", width: 2, points: [p(40, 20), p(40, 80)] };
const outside: InkStroke = { id: "outside", width: 2, points: [p(140, 20), p(140, 80)] };
const loop = [
  p(0, 0),
  p(50, 0),
  p(100, 0),
  p(100, 50),
  p(100, 100),
  p(50, 100),
  p(0, 100),
  p(0, 50),
  p(0, 0),
];

describe("白板几何与手势", () => {
  it("折返轨迹绕过内容时不能用端点连线制造删除命中", () => {
    const curved = [
      p(10, 50),
      p(40, 0),
      p(90, 50),
      p(40, 0),
      p(10, 50),
      p(40, 0),
      p(90, 50),
      p(40, 0),
      p(10, 50),
      p(40, 0),
      p(90, 50),
    ];
    const untouched = { ...line, points: [p(40, 45), p(40, 55)] };
    expect(erasedStrokes(curved, [untouched], 1)).toEqual([]);
  });
  it("多次折返跨过笔迹才删除，普通横线、圆和空白涂划都不删除", () => {
    const scratch = [p(10, 25), p(90, 35), p(10, 45), p(90, 55), p(10, 65), p(90, 75)];
    expect(erasedStrokes(scratch, [line, outside], 1)).toEqual(["inside"]);
    expect(erasedStrokes([p(0, 50), p(90, 50)], [line], 1)).toEqual([]);
    expect(erasedStrokes(loop, [line], 1)).toEqual([]);
    expect(erasedStrokes(scratch, [outside], 1)).toEqual([]);
    // 事件采样变密不会把一次穿越误判为多次折返。
    const dense = Array.from({ length: 100 }, (_, x) => p(x, 50));
    expect(erasedStrokes(dense, [line], 1)).toEqual([]);
  });

  it("缩放围绕指针保持同一世界坐标，限制极端缩放", () => {
    const view = { x: 60, y: -20, scale: 2 };
    const before = toWorld(view, 200, 100);
    const next = zoomAt(view, 200, 100, 1.5);
    expect(toWorld(next, 200, 100)).toEqual(before);
    expect(zoomAt(view, 200, 100, 1e9).scale).toBe(8);
    expect(zoomAt(view, 200, 100, 1e-9).scale).toBe(0.1);
  });
});
