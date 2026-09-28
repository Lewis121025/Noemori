import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreInput, CoreOutput } from "../../../../../modules/notes/packages/desktop/src/main/core-protocol";

const { port, service } = vi.hoisted(() => ({
  port: {
    on: vi.fn(),
    postMessage: vi.fn((message: CoreOutput, transfer: ArrayBuffer[] = []) =>
      structuredClone(message, { transfer }),
    ),
    close: vi.fn(),
  },
  service: {
    fileRead: vi.fn(),
    fileSnapshot: vi.fn(),
    fileWrite: vi.fn(),
    searchQuery: vi.fn(),
    shutdown: vi.fn(),
  },
}));
vi.mock("node:worker_threads", () => ({ parentPort: port, workerData: "/state" }));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/core-service", () => ({
  createCoreService: () => service,
}));

let receive: (message: CoreInput) => void;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  port.on.mockImplementation((_event: string, listener: typeof receive) => {
    receive = listener;
  });
  await import("../../../../../modules/notes/packages/desktop/src/main/core-worker");
});

describe("内核结果的缓冲区所有权", () => {
  it("异步搜索不堵塞保存，停机等待已取消的任务回复后关闭通道", async () => {
    let resolve!: (value: unknown) => void;
    service.searchQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    service.fileWrite.mockReturnValue({ status: "saved", warning: null });
    receive({
      type: "call",
      id: 1,
      command: "searchQuery",
      args: [{ expr: { kind: "term", value: "alpha" }, limit: 2 }, "search-id", null],
    });
    expect(port.postMessage).not.toHaveBeenCalled();
    receive({ type: "call", id: 2, command: "fileWrite", args: ["a.md", new Uint8Array(), null] });
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "result", id: 2 }),
      [],
    );
    receive({ type: "shutdown" });
    expect(service.shutdown).toHaveBeenCalledTimes(1);
    expect(port.close).not.toHaveBeenCalled();
    resolve({ hits: [], nextCursor: null });
    await vi.waitFor(() => expect(port.close).toHaveBeenCalledTimes(1));
    expect(port.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "result",
      "result",
      "stopped",
    ]);
  });

  it("读取结果直接转移独占字节，接收端得到完整内容", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    service.fileRead.mockReturnValue(bytes);
    receive({ type: "call", id: 1, command: "fileRead", args: ["a.bin"] });
    expect(port.postMessage.mock.results[0]?.value).toEqual({
      type: "result",
      id: 1,
      value: new Uint8Array([1, 2, 3]),
    });
    expect(bytes.byteLength).toBe(0);
  });

  it("快照中的磁盘、草稿和基线一起转移，缺失值保持 null", () => {
    const disk = new Uint8Array([1]);
    const bytes = new Uint8Array([2]);
    const base = new Uint8Array([3]);
    service.fileSnapshot.mockReturnValue({ disk, draft: { bytes, base } });
    receive({ type: "call", id: 1, command: "fileSnapshot", args: ["a.md"] });
    expect(port.postMessage.mock.results[0]?.value).toEqual({
      type: "result",
      id: 1,
      value: {
        disk: new Uint8Array([1]),
        draft: { bytes: new Uint8Array([2]), base: new Uint8Array([3]) },
      },
    });
    expect([disk.byteLength, bytes.byteLength, base.byteLength]).toEqual([0, 0, 0]);
    service.fileSnapshot.mockReturnValue({ disk: null, draft: null });
    receive({ type: "call", id: 2, command: "fileSnapshot", args: ["missing.md"] });
    expect(port.postMessage.mock.results[1]?.value).toEqual({
      type: "result",
      id: 2,
      value: { disk: null, draft: null },
    });
  });

  it("冲突转移磁盘副本，保存输入保留所有权", () => {
    const disk = new Uint8Array([1]);
    const bytes = new Uint8Array([2]);
    const base = new Uint8Array([3]);
    service.fileWrite.mockReturnValue({ status: "conflict", disk });
    receive({ type: "call", id: 1, command: "fileWrite", args: ["a.md", bytes, base] });
    expect(port.postMessage.mock.results[0]?.value).toEqual({
      type: "result",
      id: 1,
      value: { status: "conflict", disk: new Uint8Array([1]) },
    });
    expect(disk.byteLength).toBe(0);
    expect(bytes).toEqual(new Uint8Array([2]));
    expect(base).toEqual(new Uint8Array([3]));
  });
});
