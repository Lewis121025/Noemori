import { expect, it } from "vitest";
import { repairShape } from "@reader/shared/whiteboard/fitting";
import cases from "../../fixtures/whiteboard/traversal-regressions.json";
it.each(cases)("全量抖动/局部回描不能破坏$label的宏观推进：$sample_id", (row) => {
  const points = row.points.map(([x, y]) => ({ x: x!, y: y!, pressure: 0.5 })),
    original = structuredClone(points),
    fit = repairShape(points, 1, points);
  expect(fit?.label).toBe(row.label);
  expect(points).toEqual(original);
});
