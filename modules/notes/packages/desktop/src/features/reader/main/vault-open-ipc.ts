import { app, dialog, ipcMain, type BrowserWindow, type WebContents } from "electron";
import { join } from "node:path";
import type { ReaderClient } from "./ipc";
import type { NativeControl } from "@noemori/vault-node";
import { parseVaultOpenProgress } from "../shared/vault-opening";
import { parseVaultOpenId } from "../shared/vault-opening";

/** 开库进度与取消直接读取 Rust 内存状态；同窗口只允许一个请求。 */
export function registerVaultOpenIpc(
  getWindow: () => BrowserWindow | null,
  core: ReaderClient,
): void {
  const active = new Map<number, { id: string; control: NativeControl }>();
  async function open(sender: WebContents, value: unknown, mode: "choose" | "default" | "restore") {
    const id = parseVaultOpenId(value);
    if (active.has(sender.id)) throw new Error("已有资料库正在打开");
    const control = core.createControl();
    active.set(sender.id, { id, control });
    let previous = "";
    const report = () => {
      const progress = parseVaultOpenProgress(control.progress);
      const key = JSON.stringify(progress);
      if (previous === key || sender.isDestroyed()) return;
      previous = key;
      sender.send("reader.vault.progress", id, progress);
    };
    const cancel = () => {
      control.cancel();
    };
    sender.once("destroyed", cancel);
    const timer = setInterval(report, 80);
    timer.unref();
    try {
      report();
      if (mode === "restore") return await core.call("vaultRestore", control);
      let root: string | undefined;
      if (mode === "default") {
        root = join(app.getPath("documents"), "Noemori");
      } else {
        const window = getWindow();
        const result = window
          ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
          : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled) return null;
        root = result.filePaths[0];
      }
      if (root === undefined || control.cancelled) return null;
      return await core.call(mode === "default" ? "vaultCreate" : "vaultOpen", root, control);
    } finally {
      clearInterval(timer);
      sender.removeListener("destroyed", cancel);
      active.delete(sender.id);
    }
  }
  ipcMain.handle("reader.vault.open", ({ sender }, id: unknown) => open(sender, id, "choose"));
  ipcMain.handle("reader.vault.restore", ({ sender }, id: unknown) => open(sender, id, "restore"));
  ipcMain.handle("reader.vault.createDefault", ({ sender }, id: unknown) =>
    open(sender, id, "default"),
  );
  ipcMain.handle("reader.vault.cancel", ({ sender }, value: unknown) => {
    const id = parseVaultOpenId(value);
    const current = active.get(sender.id);
    return current?.id === id ? current.control.cancel() : false;
  });
}
