import { beforeEach, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { registerIpc } from "../../../../../modules/notes/packages/desktop/src/main/ipc";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";
import { createCloseGate } from "../../../../../modules/notes/packages/desktop/src/main/close-gate";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/core-client", () => ({
  CoreClient: class {
    call = call;
  },
}));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/menu", () => ({
  updateHistoryMenu: vi.fn(),
}));
vi.mock("../../../../../modules/notes/packages/desktop/src/features/reader/main/ipc", () => ({
  registerReaderIpc: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  app: {},
  nativeTheme: {},
}));

beforeEach(() => {
  vi.resetAllMocks();
  call.mockResolvedValue(undefined);
  registerIpc(() => null, createCloseGate(), new CoreClient("/state", vi.fn()));
});

function invoke(channel: string, value?: unknown): unknown {
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`未注册 IPC：${channel}`);
  return Reflect.apply(handler, undefined, [{}, value]);
}

it("读取配色使用归一化会话，保存只提交配色字段", async () => {
  call.mockResolvedValueOnce({ readingPalette: "green" });
  await expect(invoke("readingPalette.get")).resolves.toBe("green");
  expect(call).toHaveBeenLastCalledWith("sessionLoad");
  for (const readingPalette of ["monochrome", "green"]) {
    await expect(invoke("readingPalette.set", readingPalette)).resolves.toBeUndefined();
    expect(call).toHaveBeenLastCalledWith("sessionPatch", { readingPalette });
  }
});

it("非法配色在写入前拒绝", async () => {
  for (const value of [undefined, null, "blue", "__proto__", {}, [], 1, true])
    await expect(invoke("readingPalette.set", value)).rejects.toThrow("无效的阅读配色");
  expect(call).not.toHaveBeenCalled();
});

it("保存失败保留原因，禁止自动重试", async () => {
  call.mockRejectedValueOnce(new Error("磁盘只读"));
  await expect(invoke("readingPalette.set", "green")).rejects.toThrow("磁盘只读");
  expect(call).toHaveBeenCalledExactlyOnceWith("sessionPatch", { readingPalette: "green" });
});
