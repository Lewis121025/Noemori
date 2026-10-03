import { afterEach, describe, expect, it, vi } from "vitest";
import { packExportDocument } from "@reader/main/export/computation";
import { parseMarkdown } from "@reader/shared/markdown/parse";

const boundary = vi.hoisted(() => ({
  available: true,
  listen: vi.fn<(name: string, listener: (value: unknown) => Promise<void>) => void>(),
  send: vi.fn(),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get parentPort() {
    return boundary.available ? { on: boundary.listen, postMessage: boundary.send } : null;
  },
}));
afterEach(() => {
  boundary.available = true;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("EXP-PARSE 线程入口的协议拒绝与错误交付", () => {
  it("计算动作传回可转移字节，公式失败保留来源信息而非丢成普通字符串", async () => {
    await import("@reader/main/export/worker");
    const receive = boundary.listen.mock.calls[0]?.[1];
    if (!receive) throw new Error("线程没有接收入口");
    const doc = parseMarkdown("$\\unknownCommand{x}$");
    const document = packExportDocument({
      path: "source.md",
      output: "source.md",
      doc,
      anchors: [],
      locations: new Map(),
      formulaLocations: new Map(),
    });
    await receive({ id: 1, computation: { kind: "markdown", document } });
    expect(boundary.send).toHaveBeenLastCalledWith({ id: 1, value: expect.any(Uint8Array) }, [
      expect.any(ArrayBuffer),
    ]);
    await receive({ id: 2, computation: { kind: "checkMath", document } });
    expect(boundary.send).toHaveBeenLastCalledWith({
      id: 2,
      error: {
        issues: [
          {
            path: "source.md",
            severity: "error",
            message: expect.stringContaining("公式无法导出"),
          },
        ],
      },
    });
    for (const request of [
      { id: 3, computation: {}, bytes: new Uint8Array() },
      { id: 3, extra: true },
      { id: 3, bytes: new Uint8Array(), extra: true },
    ])
      await expect(receive(request)).rejects.toThrow("请求无效");
  });
  it("入口只接收字节及任务编号，解析错误也带相同编号返回", async () => {
    await import("@reader/main/export/worker");
    const receive = boundary.listen.mock.calls[0]?.[1];
    if (!receive) throw new Error("线程没有接收入口");
    for (const value of [null, {}, { id: -1, bytes: new Uint8Array() }, { id: 1, bytes: "text" }])
      await expect(receive(value)).rejects.toThrow("请求无效");
    await receive({ id: 1, bytes: new TextEncoder().encode("# 正文\n") });
    expect(boundary.send).toHaveBeenLastCalledWith(
      {
        id: 1,
        value: { doc: expect.objectContaining({ type: "doc" }), formulas: [] },
      },
      [],
    );
    await receive({ id: 2, bytes: new Uint8Array([0xff]) });
    expect(boundary.send).toHaveBeenLastCalledWith({ id: 2, error: expect.any(String) });
  });
  it("入口没有线程通道时不能在宿主上执行", async () => {
    boundary.available = false;
    await expect(import("@reader/main/export/worker")).rejects.toThrow("工作线程启动");
  });
});
