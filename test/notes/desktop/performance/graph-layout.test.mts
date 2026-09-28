import { expect, test } from "vitest";
import { LayoutRun } from "../../../../modules/notes/packages/desktop/src/features/reader/renderer/graph/layout";
import { checkBudget } from "./budget";

/** 固定种子的线性同余序列，保证每次验收用同一张图。 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 五千节点、一万条边：接近万篇笔记库里常见的链接密度。 */
function request(count: number, edges: number) {
  const next = random(7);
  const links = new Uint32Array(edges * 2);
  for (let index = 0; index < links.length; index += 1) links[index] = Math.floor(next() * count);
  return { count, links, seeds: new Float32Array(count * 2).fill(Number.NaN) };
}

test("五千节点布局：单步推进 P95 不超过一个 Worker 时间片，整体在预算内收敛", async () => {
  const run = new LayoutRun(request(5000, 10000));
  const steps: number[] = [];
  const started = performance.now();
  while (!run.done) {
    const tick = performance.now();
    run.step(1);
    steps.push(performance.now() - tick);
  }
  const total = performance.now() - started;
  console.info(JSON.stringify({ scenario: "graph-layout-total", ticks: steps.length, total }));
  // 单步耗时决定 Worker 回帧节奏：超过 12 ms 时间片就会让首帧与交互反馈变钝。
  await checkBudget("graph-layout-step", steps, 12);
  expect(total, "五千节点布局收敛超出 6 s 预算").toBeLessThanOrEqual(6000);
  const positions = run.positions();
  expect(positions.every(Number.isFinite)).toBe(true);
});
