import { contextBridge, ipcRenderer } from "electron";
import { createReaderApi } from "../features/reader/preload/api";
import type { Appearance, AppApi, NousApi } from "../shared/api";
import { parseAppCommand } from "../shared/api";

const app: AppApi = {
  historyChanged: (availability) => ipcRenderer.send("app.historyChanged", availability),
  subscribeCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const command = parseAppCommand(value);
      if (command !== null) callback(command);
    };
    ipcRenderer.on("app.command", listener);
    return () => ipcRenderer.removeListener("app.command", listener);
  },
  appearanceGet: () => ipcRenderer.invoke("appearance.get") as Promise<Appearance>,
  appearanceSet: (appearance) => ipcRenderer.invoke("appearance.set", appearance) as Promise<void>,
  subscribeFlushBeforeClose: (callback: () => void) => {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on("app.flushBeforeClose", listener);
    return () => {
      ipcRenderer.removeListener("app.flushBeforeClose", listener);
    };
  },
  closeAfterFlush: () => ipcRenderer.invoke("app.closeAfterFlush") as Promise<void>,
  closeBlocked: () => ipcRenderer.invoke("app.closeBlocked") as Promise<void>,
};
const api: NousApi = { app, reader: createReaderApi() };
contextBridge.exposeInMainWorld("nous", api);
