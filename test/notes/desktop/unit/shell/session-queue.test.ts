import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionWrite, SESSION_MAX_DELAY_MS } from "@reader/renderer/session-write";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("连续变化合并为最新状态，持续变化仍在最长等待内提交", async () => {
  let value = 0;
  const saved: number[] = [];
  const queue = createSessionWrite({
    delayMs: 300,
    write: async () => {
      saved.push(value);
    },
    report: vi.fn(),
  });
  for (value = 0; value < 10; value++) queue.request();
  await vi.advanceTimersByTimeAsync(299);
  expect(saved).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saved).toEqual([10]);
  saved.length = 0;
  for (let elapsed = 0; elapsed < SESSION_MAX_DELAY_MS; elapsed += 100) {
    value++;
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(saved).toEqual([value]);
  queue.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("慢写入期间只保留最新请求，所有显式冲刷等待最新提交", async () => {
  let value = 0;
  let finish!: () => void;
  const saved: number[] = [];
  const queue = createSessionWrite({
    delayMs: 300,
    report: vi.fn(),
    write: async () => {
      saved.push(value);
      if (saved.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    },
  });
  queue.request();
  const first = queue.flush();
  await Promise.resolve();
  for (value = 1; value <= 1000; value++) {
    queue.request();
    expect(queue.flush()).toBe(first);
  }
  expect(saved).toEqual([0]);
  expect(vi.getTimerCount()).toBe(0);
  finish();
  await first;
  expect(saved).toEqual([0, 1001]);
  queue.dispose();
});

it("后台失败只报告一次并保留待写状态，不自动重试刷盘，显式冲刷可以重试", async () => {
  const report = vi.fn();
  const write = vi.fn(async () => {}).mockRejectedValueOnce(new Error("磁盘不可写"));
  const queue = createSessionWrite({ delayMs: 300, write, report });
  queue.request();
  await vi.advanceTimersByTimeAsync(300);
  expect(report).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(write).toHaveBeenCalledTimes(1);
  await queue.flush();
  expect(write).toHaveBeenCalledTimes(2);
  queue.dispose();
});

it("失败后的新变化重新合并，不能因旧期限已经过去而逐事件重试", async () => {
  const write = vi.fn(async () => {}).mockRejectedValueOnce(new Error("暂时不可写"));
  const queue = createSessionWrite({ delayMs: 300, write, report: vi.fn() });
  queue.request();
  await vi.advanceTimersByTimeAsync(5000);
  queue.request();
  await vi.advanceTimersByTimeAsync(299);
  expect(write).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(2);
  queue.dispose();
});

it("重置取消尚未发送的旧快照，新状态仍等待在途任务结束后提交", async () => {
  let release!: () => void;
  let current = "old";
  const saved: string[] = [];
  const queue = createSessionWrite({
    delayMs: 300,
    report: vi.fn(),
    write: async (isCurrent) => {
      const value = current;
      if (value === "old")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (isCurrent()) saved.push(value);
    },
  });
  queue.request();
  const old = queue.flush();
  await Promise.resolve();
  queue.reset();
  current = "new";
  queue.request();
  const latest = queue.flush();
  release();
  await Promise.all([old, latest]);
  expect(saved).toEqual(["new"]);
  queue.dispose();
});

it("不稳定的界面暂停后台捕获，恢复后保存；卸载取消计时与迟到任务", async () => {
  let ready = false;
  const write = vi.fn(async () => {});
  const queue = createSessionWrite({ delayMs: 300, write, report: vi.fn(), ready: () => ready });
  queue.request();
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).not.toHaveBeenCalled();
  ready = true;
  queue.resume();
  await vi.advanceTimersByTimeAsync(300);
  expect(write).toHaveBeenCalledTimes(1);
  queue.request();
  queue.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
