import { ipcRenderer } from "electron";
import type { AgentApi } from "../shared/api";

/**
 * preload 只适配固定 Agent 动作，原生实例和认证原文不进入主世界。
 * @returns 等待宿主就绪的固定接口；业务方法通过各自的 Promise 原样传播 IPC 异常。
 */
export function createAgentApi(): AgentApi {
  // 主框架加载期间宿主拒绝 Agent 请求；每个 preload 等待自己的加载完成通知后再派发。
  const ready = new Promise<void>((resolve) => ipcRenderer.once("agent.ready", () => resolve()));
  const invoke = (channel: string, ...args: unknown[]) =>
    ready.then(() => ipcRenderer.invoke(channel, ...args));
  return {
    uiPreview: (id, target) => invoke("agent.uiPreview", id, target),
    browserChooseFiles: (id, page, token) => invoke("agent.browserChooseFiles", id, page, token),
    browserInput: (id, page, token, input) => invoke("agent.browserInput", id, page, token, input),
    settingsGet: (id) => invoke("agent.settingsGet", id),
    providersGet: () => invoke("agent.providersGet"),
    providersDiscover: (connection) => invoke("agent.providersDiscover", connection),
    providersRefresh: (id) => invoke("agent.providersRefresh", id),
    providersSave: (settings) => invoke("agent.providersSave", settings),
    providersRemove: (id) => invoke("agent.providersRemove", id),
    modelSelect: (id, selection) => invoke("agent.modelSelect", id, selection),
    pickWorkspace: () => invoke("agent.pickWorkspace"),
    create: (workspace, title) => invoke("agent.create", workspace, title),
    attachVault: (root) => invoke("agent.attachVault", root),
    createArticle: (request) => invoke("agent.createArticle", request),
    remapArticles: (root, changes) => invoke("agent.remapArticles", root, changes),
    fork: (id, request) => invoke("agent.fork", id, request),
    list: () => invoke("agent.list"),
    snapshot: (id) => invoke("agent.snapshot", id),
    start: (id, text) => invoke("agent.start", id, text),
    cancel: (id, runId) => invoke("agent.cancel", id, runId),
    resume: (id, runId) => invoke("agent.resume", id, runId),
    browserControl: (id, resume) => invoke("agent.browserControl", id, resume),
    uiControl: (id, backend, resume) => invoke("agent.uiControl", id, backend, resume),
    uiSetup: () => invoke("agent.uiSetup"),
    uiPermissions: (id) => invoke("agent.uiPermissions", id),
    rename: (id, title) => invoke("agent.rename", id, title),
    archive: (id, archived) => invoke("agent.archive", id, archived),
    remove: (id) => invoke("agent.remove", id),
    saveDraft: (id, draft) => invoke("agent.saveDraft", id, draft),
    flush: () => invoke("agent.flush"),
    approve: (id, approval, reply) => invoke("agent.approve", id, approval, reply),
    terminalRead: (id, terminal, offset) => invoke("agent.terminalRead", id, terminal, offset),
    terminalInput: (id, terminal, data) => invoke("agent.terminalInput", id, terminal, data),
    terminalStop: (id, terminal) => invoke("agent.terminalStop", id, terminal),
    terminalAction: (id, arguments_) => invoke("agent.terminalAction", id, arguments_),
    subscribe: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        if (typeof value === "string") callback(value);
      };
      ipcRenderer.on("agent.changed", listener);
      return () => ipcRenderer.removeListener("agent.changed", listener);
    },
  };
}
