import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AgentService } from "./service";
import { parseApprovalReply, parseModelSettings } from "../shared/parse";

/** 所有 Agent 请求验证当前主窗口和主框架，导出窗口与嵌入网页不能调用。 */
export function registerAgentIpc(
  getWindow: () => BrowserWindow | null,
  getService: () => AgentService | null,
): void {
  const own = (event: IpcMainInvokeEvent): AgentService => {
    const window = getWindow();
    const service = getService();
    if (
      !window ||
      !service ||
      window.webContents.isDestroyed() ||
      window.webContents.isLoadingMainFrame() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Agent 请求不属于当前主窗口");
    return service;
  };
  const id = (value: unknown): string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128)
      throw new Error("Agent 会话标识无效");
    return value;
  };
  ipcMain.handle("agent.settingsGet", (event) => own(event).settingsGet());
  ipcMain.handle("agent.settingsSet", (event, value: unknown) =>
    own(event).settingsSet(parseModelSettings(value)),
  );
  ipcMain.handle("agent.create", async (event) => {
    const service = own(event);
    const window = getWindow();
    if (!window) throw new Error("主窗口不存在");
    const result = await dialog.showOpenDialog(window, {
      title: "选择 Agent 工作区",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const workspace = result.filePaths[0];
    if (!workspace) throw new Error("没有选择工作区");
    if (own(event) !== service) throw new Error("选择工作区期间窗口已改变");
    return service.create(workspace);
  });
  ipcMain.handle("agent.list", (event) => own(event).list());
  ipcMain.handle("agent.snapshot", (event, session: unknown) => own(event).snapshot(id(session)));
  ipcMain.handle("agent.start", (event, session: unknown, value: unknown) => {
    if (typeof value !== "string" || value.length > 128 * 1024)
      throw new Error("Agent 用户输入无效");
    return own(event).start(id(session), value);
  });
  ipcMain.handle("agent.cancel", (event, session: unknown) => own(event).cancel(id(session)));
  ipcMain.handle("agent.browserControl", (event, session: unknown, resume: unknown) => {
    if (typeof resume !== "boolean") throw new Error("浏览器控制请求无效");
    return own(event).browserControl(id(session), resume);
  });
  ipcMain.handle("agent.close", (event, session: unknown) => own(event).close(id(session)));
  ipcMain.handle("agent.approve", (event, session: unknown, approval: unknown, reply: unknown) =>
    own(event).approve(id(session), id(approval), parseApprovalReply(reply)),
  );
  ipcMain.handle(
    "agent.terminalRead",
    (event, session: unknown, terminal: unknown, offset: unknown) => {
      if (typeof offset !== "string" || !/^\d{1,20}$/.test(offset)) throw new Error("终端游标无效");
      return own(event).terminalRead(id(session), id(terminal), offset);
    },
  );
  ipcMain.handle(
    "agent.terminalInput",
    (event, session: unknown, terminal: unknown, data: unknown) => {
      if (!(data instanceof Uint8Array) || data.byteLength > 16384)
        throw new Error("终端输入无效或超过 16 KiB");
      return own(event).terminalInput(id(session), id(terminal), data);
    },
  );
  ipcMain.handle("agent.terminalStop", (event, session: unknown, terminal: unknown) =>
    own(event).terminalStop(id(session), id(terminal)),
  );
  ipcMain.handle("agent.terminalAction", (event, session: unknown, arguments_: unknown) =>
    own(event).terminalAction(id(session), arguments_),
  );
}
