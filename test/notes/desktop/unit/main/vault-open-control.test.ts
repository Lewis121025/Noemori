import { expect, it } from "vitest";
import { VaultOpenControl } from "@reader/main/vault-open-control";

it("取消跨共享缓冲区立即可见，取消后不能提交", () => {
  const main = new VaultOpenControl();
  const worker = new VaultOpenControl(main.buffer);
  worker.update({ phase: "reading", completed: 100, total: 1000 });
  expect(main.progress).toEqual({ phase: "reading", completed: 100, total: 1000 });
  expect(main.cancel()).toBe(true);
  expect(worker.cancelled).toBe(true);
  expect(worker.commit()).toBe(false);
});

it("最终提交赢得边界后，迟到取消不能把成功误报为取消", () => {
  const main = new VaultOpenControl();
  const worker = new VaultOpenControl(main.buffer);
  expect(worker.commit()).toBe(true);
  expect(main.cancel()).toBe(false);
  expect(worker.cancelled).toBe(false);
  expect(main.progress.phase).toBe("committing");
});

it("执行线程停在发布中间时，读取沿用完整快照而不阻塞主线程", () => {
  const control = new VaultOpenControl();
  control.update({ phase: "reading", completed: 10, total: 100 });
  expect(control.progress.completed).toBe(10);
  const state = new Int32Array(control.buffer);
  Atomics.add(state, 4, 1);
  Atomics.store(state, 2, 999);
  expect(control.progress).toEqual({ phase: "reading", completed: 10, total: 100 });
});
