import { app, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { parseAppearance, parseHistoryAvailability } from "../shared/api";
import { registerReaderIpc } from "../features/reader/main/ipc";
import { onFlushResult, type CloseGate } from "./close-gate";
import type { CoreClient } from "./core-client";
import { updateHistoryMenu } from "./menu";

/**
 * 装配应用级与功能级 IPC；外壳不处理文件或索引业务。
 * @param getWindow 当前窗口，用于关闭及功能对话框。
 * @param closeGate 退出闸门。
 * @param core 由工作线程持有的服务客户端。
 * @throws 重复注册及命令错误由 Electron 传播。
 */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  closeGate: CloseGate,
  core: CoreClient,
): void {
  registerReaderIpc(getWindow, core);
  ipcMain.on("app.historyChanged", (event, value: unknown) => {
    const contents = getWindow()?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    )
      return;
    const availability = parseHistoryAvailability(value);
    if (availability !== null) updateHistoryMenu(availability);
  });
  ipcMain.handle("appearance.get", () => nativeTheme.themeSource);
  ipcMain.handle("appearance.set", async (_event, value: unknown) => {
    const appearance = parseAppearance(value);
    if (appearance === null) throw new Error("无效的外观设置");
    // 先持久化再更新系统控件与 prefers-color-scheme，失败时两端仍保持原选择。
    await core.call("sessionPatch", { appearance });
    nativeTheme.themeSource = appearance;
  });

  ipcMain.handle("app.closeAfterFlush", () => {
    const action = onFlushResult(closeGate, true);
    if (action === "quit") {
      app.quit();
      return;
    }
    if (action === "close") {
      getWindow()?.close();
    }
  });

  ipcMain.handle("app.closeBlocked", () => {
    onFlushResult(closeGate, false);
  });
}
