import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createWhiteboardProcessor } from "@reader/main/whiteboard-processor";
const state = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, ...values: unknown[]) => boolean;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    unref = vi.fn();
    constructor() {
      super();
      state.workers.push(this);
    }
  },
}));
const points = [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 100, y: 0, pressure: 0.5 },
  ],
  request = { points, observations: points, scale: 1 };
beforeEach(() => {
  state.workers = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
it("线程惰性启动、消息绑定身份，联动返回不能引用其他上下文", async () => {
  const processor = createWhiteboardProcessor();
  expect(state.workers).toHaveLength(0);
  const result = processor.repair(request),
    worker = state.workers[0]!;
  expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, request });
  worker.emit("message", { id: 1, value: { label: "line", points } });
  await expect(result).resolves.toEqual({ label: "line", points });
  const invalid = processor.repair(request);
  worker.emit("message", {
    id: 2,
    value: { label: "line", points, replacements: [{ id: "foreign", points }] },
  });
  await expect(invalid).rejects.toThrow("身份无效");
  await processor.close();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("限流、关闭与迟到响应不遗留计算或未完成Promise", async () => {
  const processor = createWhiteboardProcessor(),
    results = Array.from({ length: 4 }, () => processor.repair(request));
  const assertions = results.map((p) => expect(p).rejects.toThrow("关闭"));
  await expect(processor.repair(request)).rejects.toThrow("过多");
  await processor.close();
  await Promise.all(assertions);
  state.workers[0]!.emit("message", { id: 1, value: null });
  await expect(processor.repair(request)).rejects.toThrow("关闭");
});
it.each(["error", "exit", "protocol", "timeout"])(
  "%s拒绝全部在途，后续请求显式重建线程",
  async (action) => {
    const processor = createWhiteboardProcessor(),
      result = processor.repair(request),
      rejection = expect(result).rejects.toThrow(),
      worker = state.workers[0]!;
    if (action === "timeout") await vi.advanceTimersByTimeAsync(10000);
    else if (action === "protocol") worker.emit("message", { id: "wrong", value: null });
    else worker.emit(action, action === "error" ? new Error("运算失败") : 1);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const retry = processor.repair(request);
    expect(state.workers).toHaveLength(2);
    state.workers[1]!.emit("message", { id: 2, value: null });
    await expect(retry).resolves.toBeNull();
    await processor.close();
  },
);
