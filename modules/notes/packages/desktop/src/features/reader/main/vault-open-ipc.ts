import { app, dialog, ipcMain, shell, type BrowserWindow, type WebContents } from "electron";
import { isAbsolute, join } from "node:path";
import { realpath } from "node:fs/promises";
import type { DirectoryImported, ReaderClient } from "./ipc";
import type { NativeControl } from "@noemori/vault-node";
import { parseVaultOpenProgress } from "../shared/vault-opening";
import { parseVaultOpenId } from "../shared/vault-opening";
import { parseImportParent } from "../shared/directory-import";
import { parsePathArgument } from "../shared/reader-protocol";

function libraryRoot(): string {
  const testRoot = process.env["NOEMORI_TEST_LIBRARY_ROOT"];
  if (testRoot && process.env["NOEMORI_TEST_WINDOW"] && isAbsolute(testRoot)) return testRoot;
  return join(app.getPath("documents"), "Noemori");
}

type Operation = { kind: "library" | "restore" } | { kind: "import"; root: string; parent: string };

/** 开库进度与取消直接读取 Rust 内存状态；同窗口只允许一个请求。 */
export function registerVaultOpenIpc(
  getWindow: () => BrowserWindow | null,
  core: ReaderClient,
  onImported?: DirectoryImported,
): void {
  const active = new Map<number, { id: string; control: NativeControl }>();
  async function open(sender: WebContents, value: unknown, operation: Operation) {
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
      if (operation.kind === "restore") {
        const restored = await core.call("vaultLibraryRestore", libraryRoot(), control);
        if (restored?.imported && onImported) {
          try {
            await onImported(restored.imported.source, restored.root, restored.imported.path);
          } catch (error) {
            restored.warning = [restored.warning, `仓库已恢复，文章对话接入失败：${String(error)}`]
              .filter(Boolean)
              .join("；");
          }
        }
        return restored;
      }
      if (operation.kind === "import") {
        const window = getWindow();
        const result = window
          ? await dialog.showOpenDialog(window, {
              title: "导入文件夹",
              buttonLabel: "导入副本",
              properties: ["openDirectory"],
            })
          : await dialog.showOpenDialog({
              title: "导入文件夹",
              buttonLabel: "导入副本",
              properties: ["openDirectory"],
            });
        const selected = result.filePaths[0];
        if (result.canceled || selected === undefined || control.cancelled) return null;
        const source = await realpath(selected);
        const imported = await core.call(
          "directoryImport",
          operation.root,
          source,
          operation.parent,
          control,
        );
        if (imported && onImported) {
          try {
            await onImported(source, operation.root, imported.path);
          } catch (error) {
            imported.warning = [imported.warning, `文件已导入，文章对话接入失败：${String(error)}`]
              .filter(Boolean)
              .join("；");
          }
        }
        return imported;
      }
      if (control.cancelled) return null;
      return await core.call("vaultCreate", libraryRoot(), control);
    } finally {
      clearInterval(timer);
      sender.removeListener("destroyed", cancel);
      active.delete(sender.id);
    }
  }
  ipcMain.handle("reader.vault.open", ({ sender }, id: unknown) =>
    open(sender, id, { kind: "library" }),
  );
  ipcMain.handle("reader.vault.restore", ({ sender }, id: unknown) =>
    open(sender, id, { kind: "restore" }),
  );
  ipcMain.handle("reader.vault.createDefault", ({ sender }, id: unknown) =>
    open(sender, id, { kind: "library" }),
  );
  ipcMain.handle(
    "reader.directory.import",
    ({ sender }, id: unknown, root: unknown, parent: unknown) =>
      open(sender, id, {
        kind: "import",
        root: parsePathArgument(root),
        parent: parseImportParent(parent),
      }),
  );
  ipcMain.handle("reader.vault.reveal", () => shell.showItemInFolder(libraryRoot()));
  ipcMain.handle("reader.vault.cancel", ({ sender }, value: unknown) => {
    const id = parseVaultOpenId(value);
    const current = active.get(sender.id);
    return current?.id === id ? current.control.cancel() : false;
  });
}
