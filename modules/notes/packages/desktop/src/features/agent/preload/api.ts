import { ipcRenderer } from "electron";
import type { AgentApi } from "../shared/api";

/** preload 只适配固定 Agent 动作，原生实例和认证原文不进入主世界。 */
export function createAgentApi(): AgentApi {
  return {
    settingsGet: () => ipcRenderer.invoke("agent.settingsGet"),
    providersGet: () => ipcRenderer.invoke("agent.providersGet"),
    providersSave: (settings) => ipcRenderer.invoke("agent.providersSave", settings),
    providersRemove: (id) => ipcRenderer.invoke("agent.providersRemove", id),
    modelSelect: (selection) => ipcRenderer.invoke("agent.modelSelect", selection),
    pickWorkspace: () => ipcRenderer.invoke("agent.pickWorkspace"),
    create: (workspace, title) => ipcRenderer.invoke("agent.create", workspace, title),
    attachVault: (root) => ipcRenderer.invoke("agent.attachVault", root),
    createArticle: (request) => ipcRenderer.invoke("agent.createArticle", request),
    remapArticles: (root, changes) => ipcRenderer.invoke("agent.remapArticles", root, changes),
    fork: (id, request) => ipcRenderer.invoke("agent.fork", id, request),
    list: () => ipcRenderer.invoke("agent.list"),
    snapshot: (id) => ipcRenderer.invoke("agent.snapshot", id),
    start: (id, text) => ipcRenderer.invoke("agent.start", id, text),
    cancel: (id, runId) => ipcRenderer.invoke("agent.cancel", id, runId),
    resume: (id, runId) => ipcRenderer.invoke("agent.resume", id, runId),
    browserControl: (id, resume) => ipcRenderer.invoke("agent.browserControl", id, resume),
    rename: (id, title) => ipcRenderer.invoke("agent.rename", id, title),
    archive: (id, archived) => ipcRenderer.invoke("agent.archive", id, archived),
    remove: (id) => ipcRenderer.invoke("agent.remove", id),
    saveDraft: (id, draft) => ipcRenderer.invoke("agent.saveDraft", id, draft),
    flush: () => ipcRenderer.invoke("agent.flush"),
    approve: (id, approval, reply) => ipcRenderer.invoke("agent.approve", id, approval, reply),
    terminalRead: (id, terminal, offset) =>
      ipcRenderer.invoke("agent.terminalRead", id, terminal, offset),
    terminalInput: (id, terminal, data) =>
      ipcRenderer.invoke("agent.terminalInput", id, terminal, data),
    terminalStop: (id, terminal) => ipcRenderer.invoke("agent.terminalStop", id, terminal),
    terminalAction: (id, arguments_) => ipcRenderer.invoke("agent.terminalAction", id, arguments_),
    subscribe: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        if (typeof value === "string") callback(value);
      };
      ipcRenderer.on("agent.changed", listener);
      return () => ipcRenderer.removeListener("agent.changed", listener);
    },
  };
}
