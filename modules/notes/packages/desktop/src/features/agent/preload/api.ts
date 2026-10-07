import { ipcRenderer } from "electron";
import type { AgentApi } from "../shared/api";

/** preload 只适配固定 Agent 动作，原生实例和认证原文不进入主世界。 */
export function createAgentApi(): AgentApi {
  return {
    settingsGet: () => ipcRenderer.invoke("agent.settingsGet"),
    settingsSet: (settings) => ipcRenderer.invoke("agent.settingsSet", settings),
    create: () => ipcRenderer.invoke("agent.create"),
    list: () => ipcRenderer.invoke("agent.list"),
    snapshot: (id) => ipcRenderer.invoke("agent.snapshot", id),
    start: (id, text) => ipcRenderer.invoke("agent.start", id, text),
    cancel: (id) => ipcRenderer.invoke("agent.cancel", id),
    browserControl: (id, resume) => ipcRenderer.invoke("agent.browserControl", id, resume),
    close: (id) => ipcRenderer.invoke("agent.close", id),
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
