import { contextBridge, ipcRenderer } from "electron";
import { createReaderApi } from "../features/reader/preload/api";
import { createAgentApi } from "../features/agent/preload/api";
import type { Appearance, AppApi, NoemoriApi } from "../shared/api";
import { parseAppCommand } from "../shared/api";
import type { ReadingFont } from "../features/reader/shared/reading-font";
import { parseReadingPalette } from "../features/reader/shared/reading-palette";

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
  readingPaletteGet: async () => {
    const value: unknown = await ipcRenderer.invoke("readingPalette.get");
    const palette = parseReadingPalette(value);
    if (palette === null) throw new Error("无效的阅读配色响应");
    return palette;
  },
  readingPaletteSet: async (palette) => {
    await ipcRenderer.invoke("readingPalette.set", palette);
  },
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
const api: NoemoriApi = { app, reader: createReaderApi(), agent: createAgentApi() };
contextBridge.exposeInMainWorld("noemori", api);
