import { expect, it } from "vitest";
import { repairContext } from "@reader/shared/whiteboard/repair-context";
import type { InkPoint } from "@reader/shared/whiteboard/model";
const p = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
it("邻近范围沿真实端点连接扩展，远离当前短边的同一轮廓仍能进入计算", () => {
  const points = [p(300, 0), p(300, 40)],
    strokes = [
      { id: "top", width: 2, points: [p(0, 0), p(300, 0)] },
      { id: "left", width: 2, points: [p(0, 0), p(0, 200)] },
      { id: "bottom", width: 2, points: [p(0, 200), p(300, 200)] },
      { id: "far", width: 2, points: [p(2000, 1000), p(2200, 1000)] },
    ];
  expect(repairContext(points, points, strokes, 1).map((s) => s.id)).toEqual([
    "top",
    "left",
    "bottom",
  ]);
});
it("不截断原始观测，超长笔画整体不联动，老笔迹限制保持有界", () => {
  const points = [p(0, 0), p(100, 0)],
    huge = Array.from({ length: 8193 }, () => p(20, 20)),
    strokes = Array.from({ length: 20 }, (_, i) => ({ id: String(i), width: 2, points }));
  const context = repairContext(
    points,
    points,
    [...strokes, { id: "huge", width: 2, points, source: huge }],
    1,
  );
  expect(context.length).toBeLessThanOrEqual(16);
  expect(context.some((s) => s.id === "huge" || Number(s.id) < 5)).toBe(false);
});
