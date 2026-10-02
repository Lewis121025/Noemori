import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, ipcMain } from "electron";
import { registerIpc } from "../../../../../modules/notes/packages/desktop/src/main/ipc";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";
import { createCloseGate } from "../../../../../modules/notes/packages/desktop/src/main/close-gate";

const { updateMenu, transport } = vi.hoisted(() => ({
  updateMenu: vi.fn(),
  transport: { destroyed: false, loading: false },
}));

vi.mock("../../../../../modules/notes/packages/desktop/src/main/core-client", () => ({ CoreClient: class {} }));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/menu", () => ({ updateHistoryMenu: updateMenu }));
vi.mock("../../../../../modules/notes/packages/desktop/src/features/reader/main/ipc", () => ({
  registerReaderIpc: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BrowserWindow: class {
      webContents = {
        mainFrame: {},
        isDestroyed: () => transport.destroyed,
        isLoadingMainFrame: () => transport.loading,
      };
    },
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn() }),
    app: {},
    nativeTheme: {},
  };
});

let window: BrowserWindow | null;
beforeEach(() => {
  vi.clearAllMocks();
  transport.destroyed = false;
  transport.loading = false;
  window = new BrowserWindow();
  registerIpc(() => window, createCloseGate(), new CoreClient("/state", vi.fn()));
});
afterEach(() => ipcMain.removeAllListeners());

function currentEvent() {
  const contents = window?.webContents;
  if (!contents) throw new Error("测试窗口尚未创建");
  return { sender: contents, senderFrame: contents.mainFrame };
}

it("只接受当前窗口主页面的布尔历史投影，并保持消息顺序", () => {
  const event = currentEvent();
  ipcMain.emit("app.historyChanged", event, { undo: true, redo: false });
  ipcMain.emit("app.historyChanged", event, { undo: false, redo: true });
  expect(updateMenu.mock.calls).toEqual([
    [{ undo: true, redo: false }],
    [{ undo: false, redo: true }],
  ]);
  for (const invalid of [null, [], true, {}, { undo: true }, { undo: "true", redo: false }])
    ipcMain.emit("app.historyChanged", event, invalid);
  expect(updateMenu).toHaveBeenCalledTimes(2);
});

it("旧窗口、子页面、重载及已关闭窗口的消息不能启用菜单", () => {
  const event = currentEvent();
  const available = { undo: true, redo: true };
  ipcMain.emit("app.historyChanged", { ...event, sender: {} }, available);
  ipcMain.emit("app.historyChanged", { ...event, senderFrame: {} }, available);
  transport.loading = true;
  ipcMain.emit("app.historyChanged", event, available);
  transport.loading = false;
  transport.destroyed = true;
  ipcMain.emit("app.historyChanged", event, available);
  transport.destroyed = false;
  window = new BrowserWindow();
  ipcMain.emit("app.historyChanged", event, available);
  window = null;
  ipcMain.emit("app.historyChanged", event, available);
  expect(updateMenu).not.toHaveBeenCalled();
});
