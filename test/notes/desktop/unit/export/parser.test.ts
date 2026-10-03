import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExportProcessor } from "@reader/main/export/processor";
import { parseExportSource, unpackExportSource } from "@reader/main/export/source-parser";
import { EXPORT_LIMITS } from "@reader/shared/export";

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: function (url: URL) {
    return boundary.create(url);
  },
}));
const bytes = () => new TextEncoder().encode("# 中文\n\n$x$\n\n$$y$$\n");
function worker() {
  const value = Object.assign(new EventEmitter(), {
    postMessage:
      vi.fn<(request: { id: number; bytes: Uint8Array }, transfer: ArrayBuffer[]) => void>(),
    terminate: vi.fn(async () => 0),
  });
  boundary.create.mockReturnValue(value);
  return value;
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("EXP-PARSE 工作线程寿命、取消与数据契约", () => {
  it("计算线程错误携带原文位置，损坏的错误协议也必须拒绝", async () => {
    const thread = worker();
    const processor = createExportProcessor(new AbortController().signal);
    const issues = [{ path: "a.md", line: 7, severity: "error", message: "无法转换" }];
    const first = processor.compute({
      kind: "validateDocx",
      bytes: bytes(),
      expected: [],
      media: [],
    });
    thread.emit("message", { id: 1, error: { issues } });
    await expect(first).rejects.toMatchObject({ issues });
    const second = processor.parse(bytes());
    thread.emit("message", { id: 2, error: { issues: [{ ...issues[0], line: 0 }] } });
    await expect(second).rejects.toThrow("位置无效");
    await processor.close();
  });
  it("一千组固定种子的完成、取消、关闭及迟到消息顺序保持唯一结局且无订阅残留", async () => {
    let seed = 0x3d9f1028;
    for (let trial = 0; trial < 1000; trial++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const thread = worker();
      const controller = new AbortController();
      const processor = createExportProcessor(controller.signal);
      const result = processor.compute({
        kind: "validateDocx",
        bytes: bytes(),
        expected: [],
        media: [],
      });
      const success = seed % 3 === 0;
      const assertion = success
        ? expect(result).resolves.toBe("verified")
        : expect(result).rejects.toThrow();
      if (success) thread.emit("message", { id: 1, value: "verified" });
      else if (seed % 3 === 1) controller.abort();
      else await processor.close();
      thread.emit("message", { id: 1, value: "late reply" });
      controller.abort();
      await assertion;
      await processor.close();
      expect(thread.terminate).toHaveBeenCalledOnce();
      expect(thread.eventNames()).toEqual([]);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    }
  });
  it("同任务复用一个线程，每篇有独立编号并验证原文行号", async () => {
    const thread = worker();
    const parser = createExportProcessor(new AbortController().signal);
    for (let id = 1; id <= 2; id++) {
      const source = bytes();
      const pending = parser.parse(source);
      expect(thread.postMessage).toHaveBeenLastCalledWith({ id, bytes: source }, [source.buffer]);
      thread.emit("message", { id, value: parseExportSource(source) });
      const parsed = unpackExportSource(await pending);
      expect([...parsed.formulas.values()]).toEqual([3, 5]);
      expect(parsed.doc.textContent).toContain("中文");
    }
    expect(boundary.create).toHaveBeenCalledOnce();
    await parser.close();
    await parser.close();
    expect(thread.terminate).toHaveBeenCalledOnce();
    expect(thread.eventNames()).toEqual([]);
    await expect(parser.parse(bytes())).rejects.toThrow("关闭");
  });

  it("取消立即拒绝当前解析，清理仍等待线程真正退出", async () => {
    const thread = worker();
    let finished: (code: number) => void = () => {};
    thread.terminate.mockReturnValue(
      new Promise((resolve) => {
        finished = resolve;
      }),
    );
    const controller = new AbortController();
    const parser = createExportProcessor(controller.signal);
    const rejected = expect(parser.parse(bytes())).rejects.toThrow("取消");
    controller.abort();
    await rejected;
    let closed = false;
    const closing = parser.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    thread.emit("message", { id: 1, value: parseExportSource(bytes()) });
    finished(0);
    await closing;
    expect(closed).toBe(true);
    expect(thread.eventNames()).toEqual([]);
  });

  it.for(["error", "exit", "timeout", "protocol", "post"])(
    "异常路径不留下线程或未决解析：%s",
    async (fault) => {
      vi.useFakeTimers();
      const thread = worker();
      const parser = createExportProcessor(new AbortController().signal);
      if (fault === "post")
        thread.postMessage.mockImplementation(() => {
          throw new Error("post fault");
        });
      const rejected = expect(parser.parse(bytes())).rejects.toThrow();
      if (fault === "error") thread.emit("error", new Error("worker fault"));
      if (fault === "exit") thread.emit("exit", 0);
      if (fault === "protocol") thread.emit("message", { id: 99, value: {} });
      if (fault === "timeout") await vi.advanceTimersByTimeAsync(EXPORT_LIMITS.renderMs);
      await rejected;
      await parser.close();
      expect(thread.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("提前取消不启动线程；并发解析拒绝，不覆盖原来的待办请求", async () => {
    const thread = worker();
    const controller = new AbortController();
    controller.abort();
    const cancelled = createExportProcessor(controller.signal);
    await expect(cancelled.parse(bytes())).rejects.toThrow();
    await cancelled.close();
    expect(boundary.create).not.toHaveBeenCalled();
    const parser = createExportProcessor(new AbortController().signal);
    const first = parser.parse(bytes());
    await expect(parser.parse(bytes())).rejects.toThrow("逐篇");
    const rejection = expect(first).rejects.toThrow("source error");
    thread.emit("message", { id: 1, error: "source error" });
    await rejection;
    const next = parser.parse(bytes());
    thread.emit("message", { id: 1, value: "迟到回复不能污染下一篇" });
    thread.emit("message", { id: 2, value: parseExportSource(bytes()) });
    expect(unpackExportSource(await next).formulas.size).toBe(2);
    await parser.close();
  });

  it("线程解析结果不能省略、重复或伪造公式源码身份", () => {
    expect(() => parseExportSource(new Uint8Array([0xff]))).toThrow();
    const value = parseExportSource(bytes());
    for (const candidate of [
      null,
      {},
      { ...value, doc: { type: "paragraph" } },
      { ...value, formulas: [] },
      { ...value, formulas: [...value.formulas, ...value.formulas] },
      { ...value, formulas: [{ position: 0, line: 1 }] },
      { ...value, formulas: [{ position: 0, line: -1 }] },
    ])
      expect(() => unpackExportSource(candidate)).toThrow();
    expect(
      unpackExportSource(parseExportSource(new TextEncoder().encode("\uFEFF中文\r\n"))).doc
        .textContent,
    ).toBe("中文");
  });
});
