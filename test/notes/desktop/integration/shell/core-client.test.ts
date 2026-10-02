import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";
const { service } = vi.hoisted(() => ({
  service: {
    fileRead: vi.fn(),
    fileWrite: vi.fn(),
    vaultList: vi.fn(),
    entryRename: vi.fn(),
    shutdown: vi.fn(),
    createControl: vi.fn(),
  },
}));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/core-service", () => ({
  createCoreService: () => service,
}));
beforeEach(() => {
  vi.resetAllMocks();
  service.shutdown.mockResolvedValue(undefined);
});

describe("直接原生客户端的结果与停机边界", () => {
  it("在调用栈内顺序提交，不等待在途读取；停机同时等待原生资源和 JS 结果", async () => {
    let finish!: (value: Uint8Array) => void;
    let closed!: () => void;
    service.fileRead.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      }),
    );
    service.fileWrite.mockResolvedValue({ status: "saved", warning: null });
    service.shutdown.mockReturnValue(
      new Promise<void>((resolve) => {
        closed = resolve;
      }),
    );
    const core = new CoreClient("/state", vi.fn());
    const read = core.call("fileRead", "a.md");
    const input = new Uint8Array([7]);
    const save = core.call("fileWrite", "a.md", input, null);
    expect(service.fileRead).toHaveBeenCalledExactlyOnceWith("a.md");
    expect(service.fileWrite).toHaveBeenCalledExactlyOnceWith("a.md", input, null);
    await expect(save).resolves.toEqual({ status: "saved", warning: null });
    let stopped = false;
    const shutdown = core.shutdown();
    void shutdown.then(() => {
      stopped = true;
    });
    expect(core.shutdown()).toBe(shutdown);
    await expect(core.call("vaultList")).rejects.toThrow("内核正在关闭");
    closed();
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(new Uint8Array([42]));
    await expect(read).resolves.toEqual(new Uint8Array([42]));
    await shutdown;
    expect(stopped).toBe(true);
    expect(input).toEqual(new Uint8Array([7]));
  });
  it("操作失败保持原因，不重试写入，后续合法请求仍可执行", async () => {
    const core = new CoreClient("/state", vi.fn());
    service.entryRename.mockRejectedValue(new Error("目标已存在：b.md"));
    service.vaultList.mockResolvedValue(["a.md"]);
    await expect(core.call("entryRename", "a.md", "b.md")).rejects.toThrow("目标已存在");
    expect(service.entryRename).toHaveBeenCalledTimes(1);
    await expect(core.call("vaultList")).resolves.toEqual(["a.md"]);
    await core.shutdown();
  });
  it("原生关闭失败不能伪装成安全退出", async () => {
    service.shutdown.mockRejectedValue(new Error("停机失败"));
    const core = new CoreClient("/state", vi.fn());
    await expect(core.shutdown()).rejects.toThrow("停机失败");
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });
});
