import { app, dialog, ipcMain, type BrowserWindow, type WebContents } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReaderClient } from "./ipc";
import { VaultOpenControl } from "./vault-open-control";
import { parseVaultOpenId } from "../shared/vault-opening";

/** 开库进度与取消独立于阻塞中的工作线程队列；同窗口只允许一个请求。 */
export function registerVaultOpenIpc(
  getWindow: () => BrowserWindow | null,
  core: ReaderClient,
): void {
  const active = new Map<number, { id: string; control: VaultOpenControl }>();
  async function open(sender: WebContents, value: unknown, mode: "choose" | "default" | "restore") {
    const id = parseVaultOpenId(value);
    if (active.has(sender.id)) throw new Error("已有资料库正在打开");
    const control = new VaultOpenControl();
    active.set(sender.id, { id, control });
    let previous = "";
    const report = () => {
      const progress = control.progress;
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
      if (mode === "restore") return await core.call("vaultRestore", control.buffer);
      let root: string | undefined;
      if (mode === "default") {
        root = join(app.getPath("documents"), "Noemori");
        await mkdir(root, { recursive: true });
      } else {
        const window = getWindow();
        const result = window
          ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
          : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled) return null;
        root = result.filePaths[0];
      }
      if (root === undefined || control.cancelled) return null;
      return await core.call("vaultOpen", root, control.buffer);
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
