import { contextBridge, ipcRenderer } from "electron";
import { createReaderApi } from "../features/reader/preload/api";
import type { Appearance, AppApi, NoemoriApi } from "../shared/api";
import { parseAppCommand } from "../shared/api";
import type { ReadingFont } from "../features/reader/shared/reading-font";

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
  readingFontGet: () => ipcRenderer.invoke("readingFont.get") as Promise<ReadingFont>,
  readingFontSet: (font) => ipcRenderer.invoke("readingFont.set", font) as Promise<void>,
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
const api: NoemoriApi = { app, reader: createReaderApi() };
contextBridge.exposeInMainWorld("noemori", api);
