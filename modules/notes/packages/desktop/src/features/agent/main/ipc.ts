import { parseReferences } from "../shared/references";
import { attachmentId, parseAttachmentIds, parseAttachmentUploads } from "../shared/attachments";
import { libraryAttachmentUploads } from "./attachments";
import { parseLibraryEntriesDrag } from "../../reader/shared/file-drag";
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AgentService } from "./service";
import { parseApprovalReply, record, text } from "../shared/parse";
import {
  parseModelSelection,
  parseProviderConnection,
  parseProviderUpdate,
} from "../shared/providers";
import { isEntryPath } from "../../reader/shared/file-browser";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { parsePreviewTarget, parseBrowserHumanInput } from "../shared/preview";
/** 图片或文件可独立发送；纯文字空输入仍在 IPC 第一边界拒绝。 */
function sentInput(value: unknown, attachments: unknown): { text: string; attachments: string[] } {
  const files = parseAttachmentIds(attachments);
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 128 * 1024)
    throw new Error("Agent 用户输入无效或超过 128 KiB");
  if (!value.trim() && !files.length) throw new Error("Agent 用户输入无效：消息必须非空或包含附件");
  return { text: value, attachments: files };
}

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
  ipcMain.handle("agent.settingsGet", (event, session: unknown) =>
    own(event).settingsGet(id(session)),
  );
  ipcMain.handle("agent.browserChooseFiles", async (event, session: unknown, page: unknown, token: unknown) => {
    const service = own(event), owner = id(session), target = id(page), lease = id(token);
    const chosen = await dialog.showOpenDialog({ title: "选择工作区中的文件", properties: ["openFile", "multiSelections"] });
    if (own(event) !== service) throw new Error("窗口已改变");
    await service.browserInput(owner, target, lease, { type: "files", paths: chosen.canceled ? [] : chosen.filePaths });
  });
  ipcMain.handle("agent.uiSetup", (event) => own(event).uiSetup());
  ipcMain.handle("agent.uiPreview", (event, session: unknown, target: unknown) =>
    own(event).uiPreview(id(session), parsePreviewTarget(target)),
  );
  ipcMain.handle("agent.browserInput", (event, session: unknown, page: unknown, token: unknown, input: unknown) =>
    own(event).browserInput(id(session), id(page), id(token), parseBrowserHumanInput(input)),
  );
  ipcMain.handle("agent.uiPermissions", (event, session: unknown) =>
    own(event).uiPermissions(id(session)),
  );
  ipcMain.handle(
    "agent.uiControl",
    (event, session: unknown, backend: unknown, resume: unknown) => {
      if (
        typeof backend !== "string" ||
        !["managed", "chrome", "edge", "computer"].includes(backend) ||
        typeof resume !== "boolean"
      )
        throw new Error("界面控制请求无效");
      return own(event).uiControl(id(session), backend, resume);
    },
  );
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
  ipcMain.handle("agent.providersDiscover", (event, value: unknown) =>
    own(event).providersDiscover(parseProviderConnection(value)),
  );
  ipcMain.handle("agent.providersRefresh", (event, value: unknown) =>
    own(event).providersRefresh(id(value)),
  );
  ipcMain.handle("agent.providersSave", (event, value: unknown) =>
    own(event).providersSave(parseProviderUpdate(value)),
  );
  ipcMain.handle("agent.providersRemove", (event, value: unknown) =>
    own(event).providersRemove(id(value)),
  );
  ipcMain.handle("agent.modelSelect", (event, session: unknown, value: unknown) =>
    own(event).modelSelect(id(session), parseModelSelection(value)),
  );
  ipcMain.handle("agent.pickWorkspace", async (event) => {
    const service = own(event);
    const window = getWindow();
    if (!window) throw new Error("主窗口不存在");
    const result = await dialog.showOpenDialog(window, {
      title: "关联文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    if (!selected) throw new Error("没有选择文件夹");
    const workspace = await realpath(selected);
    if (!(await stat(workspace)).isDirectory()) throw new Error("关联目录必须是文件夹");
    if (own(event) !== service) throw new Error("选择工作区期间窗口已改变");
    selectedWorkspaces.add(workspace);
    return workspace;
  });
  ipcMain.handle("agent.attachmentsChoose", async (event, session: unknown) => {
    const service = own(event), owner = id(session), window = getWindow();
    if (!window) throw new Error("主窗口不存在");
    const current = await service.snapshot(owner);
    if (current.archived) throw new Error("请先恢复已归档的对话");
    const chosen = await dialog.showOpenDialog(window, { title: "添加附件", properties: ["openFile", "multiSelections"] });
    if (chosen.canceled) return [];
    if (own(event) !== service) throw new Error("选择附件期间窗口已改变");
    return service.addAttachments(owner, chosen.filePaths);
  });
  ipcMain.handle("agent.attachmentPreview", (event, session: unknown, file: unknown) =>
    own(event).attachmentPreview(id(session), attachmentId(file)),
  );
  ipcMain.handle("agent.attachmentsUpload", (event, session: unknown, files: unknown) =>
    own(event).addAttachments(id(session), parseAttachmentUploads(files)),
  );
  ipcMain.handle("agent.attachmentsFromLibrary", async (event, session: unknown, value: unknown) => {
    const service = own(event), owner = id(session), request = parseLibraryEntriesDrag(value);
    const root = await requireVault(request.root);
    const files = await libraryAttachmentUploads(root, request.entries);
    await requireVault(root);
    if (own(event) !== service) throw new Error("添加附件期间窗口已改变");
    return service.addAttachments(owner, files);
  });
  ipcMain.handle("agent.attachmentOpen", async (event, session: unknown, file: unknown) => {
    const service = own(event);
    const path = await service.attachmentPath(id(session), attachmentId(file));
    if (own(event) !== service) throw new Error("打开附件期间窗口已改变");
    const error = await shell.openPath(path);
    if (error) throw new Error(`无法打开附件：${error}`);
  });
  ipcMain.handle("agent.create", async (event, workspace: unknown, title: unknown) => {
    const service = own(event);
    if (typeof title !== "string") throw new Error("会话名称无效");
    if (workspace === null) return service.create(null, title);
    if (typeof workspace !== "string" || !workspace || workspace.includes("\0"))
      throw new Error("会话名称或工作目录无效");
    // 选择器、库内目录和历史记录共用真实路径身份，别名不应被误判为未确认目录。
    const destination = await realpath(workspace);
    if (!(await stat(destination)).isDirectory()) throw new Error("关联目录必须是文件夹");
    let known =
      selectedWorkspaces.has(destination) ||
      (await service.list()).items.some((item) => item.workspace === destination);
    if (!known) {
      const root = await currentVault();
      if (root !== null) {
        // 当前库及其真实子目录已由文件管理确认；符号链接不能把归属扩大到库外。
        const base = await realpath(root);
        const path = relative(base, destination);
        known = path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      }
    }
    if (!known) throw new Error("请先通过文件夹选择器确认工作目录");
    if (own(event) !== service) throw new Error("创建期间窗口已改变");
    return service.create(destination, title);
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
  ipcMain.handle("agent.start", (event, session: unknown, value: unknown, references: unknown, attachments: unknown) => {
    const input = sentInput(value, attachments);
    return own(event).start(id(session), input.text, parseReferences(references), input.attachments);
  });
  ipcMain.handle("agent.cancel", (event, session: unknown, run: unknown) =>
    own(event).cancel(id(session), id(run)),
  );
  ipcMain.handle("agent.resume", (event, session: unknown, run: unknown) =>
    own(event).resume(id(session), id(run)),
  );
  ipcMain.handle("agent.steer", (event, session: unknown, run: unknown, value: unknown, references: unknown, attachments: unknown) => {
    const input = sentInput(value, attachments);
    return own(event).steer(id(session), id(run), input.text, parseReferences(references), input.attachments);
  });
  ipcMain.handle("agent.queueGet", (event, session: unknown) => own(event).queueGet(id(session)));
  ipcMain.handle("agent.queueAdd", (event, session: unknown, run: unknown, value: unknown, references: unknown, attachments: unknown) => {
    const input = sentInput(value, attachments);
    return own(event).queueAdd(id(session), id(run), input.text, parseReferences(references), input.attachments);
  });
  ipcMain.handle("agent.queueRemove", (event, session: unknown, message: unknown) =>
    own(event).queueRemove(id(session), id(message)),
  );
  ipcMain.handle("agent.queuePause", (event, session: unknown, paused: unknown) => {
    if (typeof paused !== "boolean") throw new Error("队列暂停状态无效");
    return own(event).queuePause(id(session), paused);
  });
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
  ipcMain.handle("agent.saveDraft", (event, session: unknown, draft: unknown, references: unknown, attachments: unknown) => {
    if (typeof draft !== "string" || draft.length > 128 * 1024)
      throw new Error("会话草稿无效或过长");
    return own(event).saveDraft(id(session), draft, parseReferences(references), attachments === undefined ? undefined : parseAttachmentIds(attachments));
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
