import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AgentService } from "./service";
import { parseApprovalReply, record, text } from "../shared/parse";
import { parseModelSelection, parseProviderUpdate } from "../shared/providers";
import { isEntryPath } from "../../reader/shared/file-browser";
import { realpath } from "node:fs/promises";

/** 所有 Agent 请求验证当前主窗口和主框架，导出窗口与嵌入网页不能调用。 */
export function registerAgentIpc(
  getWindow: () => BrowserWindow | null,
  getService: () => AgentService | null,
  currentVault: () => Promise<string | null>,
): void {
  const selectedWorkspaces = new Set<string>();
  const requireVault = async (value: unknown): Promise<string> => {
    const opened = await currentVault();
    if (typeof value !== "string" || opened === null)
      throw new Error("笔记库已改变，请重新打开文章对话");
    // macOS 的 /var 与 /private/var、用户选择的目录别名都可能指向同一真实库。
    const [requested, root] = await Promise.all([realpath(value), realpath(opened)]);
    if (requested !== root) throw new Error("笔记库已改变，请重新打开文章对话");
    return root;
  };
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
  ipcMain.handle("agent.attachVault", async (event, value: unknown) => {
    const service = own(event);
    return service.attachVault(await requireVault(value));
  });
  ipcMain.handle("agent.createArticle", async (event, value: unknown) => {
    const service = own(event);
    const request = record(value);
    const root = await requireVault(request["root"]);
    return service.createArticle({
      root,
      path: text(request, "path"),
      title: text(request, "title"),
    });
  });
  ipcMain.handle("agent.remapArticles", async (event, rootValue: unknown, value: unknown) => {
    const service = own(event);
    const root = await requireVault(rootValue);
    if (!Array.isArray(value) || value.length > 10000) throw new Error("文件变化无效");
    const changes = value.map((entry: unknown) => {
      const item = record(entry);
      const from = item["from"],
        to = item["to"];
      if (!isEntryPath(from) || (to !== null && !isEntryPath(to)))
        throw new Error("文件变化路径无效");
      return { from, to };
    });
    return service.remapArticles(root, changes);
  });
  ipcMain.handle("agent.providersGet", (event) => own(event).providersGet());
  ipcMain.handle("agent.providersSave", (event, value: unknown) =>
    own(event).providersSave(parseProviderUpdate(value)),
  );
  ipcMain.handle("agent.providersRemove", (event, value: unknown) => own(event).providersRemove(id(value)));
  ipcMain.handle("agent.modelSelect", (event, value: unknown) => own(event).modelSelect(parseModelSelection(value)));
  ipcMain.handle("agent.pickWorkspace", async (event) => {
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
    selectedWorkspaces.add(workspace);
    return workspace;
  });
  ipcMain.handle("agent.create", async (event, workspace: unknown, title: unknown) => {
    const service = own(event);
    if (typeof workspace !== "string" || workspace.includes("\0") || typeof title !== "string")
      throw new Error("会话名称或工作目录无效");
    const known =
      selectedWorkspaces.has(workspace) ||
      (await service.list()).items.some((item) => item.workspace === workspace);
    if (!known) throw new Error("请先通过文件夹选择器确认工作目录");
    if (own(event) !== service) throw new Error("创建期间窗口已改变");
    return service.create(workspace, title);
  });
  ipcMain.handle("agent.fork", (event, session: unknown, value: unknown) => {
    const service = own(event);
    const request = record(value);
    return service.fork(id(session), {
      title: text(request, "title"),
      afterTurnId: request["afterTurnId"] === null ? null : id(request["afterTurnId"]),
    });
  });
  ipcMain.handle("agent.list", (event) => own(event).list());
  ipcMain.handle("agent.snapshot", (event, session: unknown) => own(event).snapshot(id(session)));
  ipcMain.handle("agent.start", (event, session: unknown, value: unknown) => {
    if (typeof value !== "string" || value.length > 128 * 1024)
      throw new Error("Agent 用户输入无效");
    return own(event).start(id(session), value);
  });
  ipcMain.handle("agent.cancel", (event, session: unknown, run: unknown) =>
    own(event).cancel(id(session), id(run)),
  );
  ipcMain.handle("agent.resume", (event, session: unknown, run: unknown) =>
    own(event).resume(id(session), id(run)),
  );
  ipcMain.handle("agent.browserControl", (event, session: unknown, resume: unknown) => {
    if (typeof resume !== "boolean") throw new Error("浏览器控制请求无效");
    return own(event).browserControl(id(session), resume);
  });
  ipcMain.handle("agent.rename", (event, session: unknown, title: unknown) => {
    if (typeof title !== "string") throw new Error("会话名称无效");
    return own(event).rename(id(session), title);
  });
  ipcMain.handle("agent.archive", (event, session: unknown, archived: unknown) => {
    if (typeof archived !== "boolean") throw new Error("归档状态无效");
    return own(event).archive(id(session), archived);
  });
  ipcMain.handle("agent.remove", (event, session: unknown) => own(event).remove(id(session)));
  ipcMain.handle("agent.saveDraft", (event, session: unknown, draft: unknown) => {
    if (typeof draft !== "string" || draft.length > 128 * 1024)
      throw new Error("会话草稿无效或过长");
    return own(event).saveDraft(id(session), draft);
  });
  ipcMain.handle("agent.flush", (event) => own(event).flush());
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
