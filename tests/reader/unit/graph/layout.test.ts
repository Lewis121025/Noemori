import { describe, expect, it } from "vitest";
import { computeLayout, LayoutRun, PositionMemory } from "@reader/renderer/engine/graph/layout";

const chain = (count: number) => {
  const links = new Uint32Array((count - 1) * 2);
  for (let index = 0; index + 1 < count; index += 1) {
    links[index * 2] = index;
    links[index * 2 + 1] = index + 1;
  }
  return links;
};
const fresh = (count: number) => new Float32Array(count * 2).fill(Number.NaN);
const distance = (positions: Float32Array, a: number, b: number) =>
  Math.hypot(positions[a * 2]! - positions[b * 2]!, positions[a * 2 + 1]! - positions[b * 2 + 1]!);

describe("computeLayout", () => {
  it("收敛出有限坐标，相连节点比不相连节点更近；同一输入结果确定", () => {
    const links = chain(6);
    const first = computeLayout({ count: 6, links, seeds: fresh(6) });
    expect(first.every(Number.isFinite)).toBe(true);
    expect(distance(first, 0, 1)).toBeLessThan(distance(first, 0, 5));
    expect(computeLayout({ count: 6, links, seeds: fresh(6) })).toEqual(first);
  });

  it("空图直接收敛", () => {
    expect(computeLayout({ count: 0, links: new Uint32Array(0), seeds: fresh(0) })).toEqual(
      new Float32Array(0),
    );
  });
});

describe("增量布局", () => {
  it("多数节点带旧坐标时只轻推：旧节点位移远小于布局尺度，新节点落在邻居附近", () => {
    const settled = computeLayout({ count: 5, links: chain(5), seeds: fresh(5) });
    const seeds = fresh(6);
    seeds.set(settled);
    const links = new Uint32Array([...chain(5), 4, 5]);
    const run = new LayoutRun({ count: 6, links, seeds });
    const start = run.positions();
    expect(distance(start, 4, 5)).toBeLessThan(20);
    while (!run.step(10));
    const next = run.positions();
    const span = distance(settled, 0, 4);
    for (let index = 0; index < 5; index += 1)
      expect(
        Math.hypot(
          next[index * 2]! - settled[index * 2]!,
          next[index * 2 + 1]! - settled[index * 2 + 1]!,
        ),
      ).toBeLessThan(span / 2);
  });
});

describe("PositionMemory", () => {
  it("按路径播种，未记过的为 NaN；被过滤掉的节点重新出现时回到原处", () => {
    const memory = new PositionMemory();
    memory.remember(["a", "b"], [1, 2, 3, 4]);
    memory.remember(["b"], [5, 6]);
    expect([...memory.seeds(["b", "c", "a"])]).toEqual([5, 6, Number.NaN, Number.NaN, 1, 2]);
  });
});
