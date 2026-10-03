import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { isAbsolute } from "node:path";
import type { NativeControl } from "@noemori/vault-node";
import type { ExportProgress, ExportResult } from "../../shared/export";
import { parseExportId, parseExportProgress, parseExportRequest } from "../../shared/export";
import { NativeExport, type ExportNativePort } from "./native";
import { createExportRenderer } from "./render";
import { prepareArtifacts } from "./pipeline";
import { errorText, ExportFailure } from "./errors";
import { createExportProcessor, type ExportProcessor } from "./processor";

/**
 * 导出 IPC 只接受当前主窗口；原生路径能力与临时渲染页面均不暴露给业务页面。
 * @throws 非法请求、任务归属错误或重复注册；业务失败返回结构化诊断。
 */
export function registerExportIpc(
  getWindow: () => BrowserWindow | null,
  core: ExportNativePort & { createControl(): NativeControl; recover(): Promise<unknown> },
): void {
  const active = new Map<number, { id: string; stop: () => boolean }>();
  const saved = new Map<number, string>();
  const delivered = new Map<number, Set<string>>();
  const port = core;
  ipcMain.handle(
    "reader.export.run",
    async ({ sender }, value: unknown, taskId: unknown): Promise<ExportResult> => {
      const parent = getWindow();
      if (!parent || parent.webContents.id !== sender.id) throw new Error("导出请求不属于当前窗口");
      const request = parseExportRequest(value);
      const id = parseExportId(taskId);
      if (active.has(sender.id)) throw new Error("已有导出任务正在执行");
      const controller = new AbortController();
      const control = core.createControl();
      const stop = (): boolean => {
        if (!control.cancel()) return false;
        controller.abort();
        return true;
      };
      active.set(sender.id, { id, stop });
      const destroyed = () => {
        stop();
        saved.delete(sender.id);
      };
      sender.once("destroyed", destroyed);
      let native: NativeExport | undefined;
      let parser: ExportProcessor | undefined;
      let result: ExportResult = {
        status: "failed",
        issues: [{ path: "", severity: "error", message: "导出没有完成" }],
      };
      let converting: ExportProgress | null = null;
      let previous = "";
      let notificationWarning: string | null = null;
      let progressFailure = "";
      const send = (channel: string, payload: unknown): void => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(channel, id, payload);
        } catch (error) {
          notificationWarning = `导出通知失败：${errorText(error)}`;
        }
      };
      const progress = (): void => {
        try {
          if (control.cancelled && !controller.signal.aborted) controller.abort();
          const snapshot = control.progress;
          if (typeof snapshot !== "object" || snapshot === null)
            throw new Error("原生导出进度无效");
          const value = converting ?? parseExportProgress({ ...snapshot, path: null });
          const version = JSON.stringify(value);
          if (version !== previous) {
            previous = version;
            send("reader.export.progress", value);
          }
        } catch (error) {
          progressFailure = errorText(error);
          stop();
        }
      };
      const timer = setInterval(progress, 80);
      timer.unref();
      try {
        progress();
        native = await NativeExport.prepare(port, request, id, control);
        parser = createExportProcessor(controller.signal);
        const renderer = createExportRenderer(controller.signal, parser.compute);
        const artifacts = await prepareArtifacts(
          native,
          request,
          renderer,
          controller.signal,
          {
            progress: (completed, total, path) => {
              converting = { phase: "converting", completed, total, path };
              progress();
            },
            plan: (plan) => send("reader.export.plan", plan),
          },
          parser.parse,
          parser.compute,
        );
        controller.signal.throwIfAborted();
        const destination = await dialog.showSaveDialog(parent, {
          title: "保存导出结果",
          defaultPath: artifacts.name,
          filters: [{ name: artifacts.extension.toUpperCase(), extensions: [artifacts.extension] }],
        });
        if (destination.canceled || !destination.filePath) {
          stop();
          result = { status: "cancelled" };
        } else {
          controller.signal.throwIfAborted();
          const exists = await native.target(destination.filePath);
          if (exists) {
            const confirmation = await dialog.showMessageBox(parent, {
              type: "question",
              message: "替换已有的导出文件？",
              detail: destination.filePath,
              buttons: ["替换", "取消"],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            if (confirmation.response !== 0) {
              stop();
              controller.signal.throwIfAborted();
            }
          }
          controller.signal.throwIfAborted();
          converting = null;
          const committed = await native.publish(artifacts.single);
          if (!sender.isDestroyed()) {
            if (!saved.has(sender.id))
              sender.once("destroyed", () => {
                saved.delete(sender.id);
                delivered.delete(sender.id);
              });
            saved.set(sender.id, committed.path);
          }
          result = {
            status: "saved",
            path: committed.path,
            issues: artifacts.issues,
            warning: [committed.warning, notificationWarning].filter(Boolean).join("；") || null,
          };
        }
      } catch (error) {
        result = progressFailure
          ? {
              status: "failed",
              issues: [{ path: "", severity: "error", message: progressFailure }],
            }
          : control.cancelled || controller.signal.aborted
            ? { status: "cancelled" }
            : {
                status: "failed",
                issues:
                  error instanceof ExportFailure
                    ? error.issues
                    : [{ path: "", severity: "error", message: errorText(error) }],
              };
      } finally {
        clearInterval(timer);
        sender.removeListener("destroyed", destroyed);
        try {
          await parser?.close();
        } catch (error) {
          if (result.status === "saved")
            result.warning = [result.warning, `结果已生成，解析线程退出失败：${errorText(error)}`]
              .filter(Boolean)
              .join("；");
          else
            result = {
              status: "failed",
              issues: [
                ...(result.status === "failed" ? result.issues : []),
                { path: "", severity: "error", message: `解析线程退出失败：${errorText(error)}` },
              ],
            };
        }
        try {
          if (native) await native.dispose();
          else await port.action(id, { action: "discard" });
        } catch (error) {
          if (result.status === "saved")
            result.warning = [result.warning, `结果已生成，暂存清理需要重试：${errorText(error)}`]
              .filter(Boolean)
              .join("；");
          else if (result.status === "failed")
            result.issues.push({
              path: "",
              severity: "error",
              message: `暂存清理失败：${errorText(error)}`,
            });
          else
            result = {
              status: "failed",
              issues: [
                {
                  path: "",
                  severity: "error",
                  message: `导出已停止，但暂存清理失败：${errorText(error)}`,
                },
              ],
            };
        }
        active.delete(sender.id);
      }
      if (result.status === "saved" && !sender.isDestroyed()) {
        const ids = delivered.get(sender.id) ?? new Set<string>();
        ids.add(id);
        delivered.set(sender.id, ids);
      }
      return result;
    },
  );
  ipcMain.handle("reader.export.acknowledge", async ({ sender }, value: unknown) => {
    const parent = getWindow();
    const id = parseExportId(value);
    if (!parent || parent.webContents.id !== sender.id || !delivered.get(sender.id)?.has(id))
      throw new Error("导出交付确认不属于当前窗口或任务");
    await port.action(id, { action: "acknowledge" });
    delivered.get(sender.id)?.delete(id);
    return;
  });
  ipcMain.handle("reader.export.recover", async ({ sender }) => {
    const parent = getWindow();
    if (!parent || parent.webContents.id !== sender.id)
      throw new Error("导出恢复请求不属于当前窗口");
    const recovered = await core.recover();
    if (!Array.isArray(recovered)) throw new Error("导出恢复响应无效");
    const records = recovered.map((value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        !("path" in value) ||
        typeof value.path !== "string" ||
        !isAbsolute(value.path) ||
        value.path.includes("\0") ||
        !("status" in value) ||
        (value.status !== "saved" && value.status !== "unconfirmed")
      )
        throw new Error("导出恢复记录无效");
      return { id: parseExportId(value.id), path: value.path, status: value.status };
    });
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("导出恢复记录重复");
    if (!records.length || sender.isDestroyed()) return;
    const single = records.length === 1 ? records[0] : undefined;
    const reveal = single?.status === "saved";
    const result = await dialog.showMessageBox(parent, {
      type: records.every((record) => record.status === "saved") ? "info" : "warning",
      title: "上次导出的结果",
      message: "已核实上次尚未确认的导出任务",
      detail: records
        .map(
          (record) =>
            `${record.status === "saved" ? "已生成" : "结果尚不能确认，请检查文件"}：${record.path}`,
        )
        .join("\n"),
      buttons: reveal ? ["知道了", "显示文件"] : ["知道了"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (sender.isDestroyed()) return;
    if (result.response === 1 && reveal && single) shell.showItemInFolder(single.path);
    for (const record of records) await port.action(record.id, { action: "acknowledge" });
    return;
  });
  ipcMain.handle("reader.export.cancel", ({ sender }, taskId: unknown) => {
    const id = parseExportId(taskId);
    const task = active.get(sender.id);
    return task?.id === id ? task.stop() : false;
  });
  ipcMain.handle("reader.export.reveal", ({ sender }) => {
    const path = saved.get(sender.id);
    if (!path || getWindow()?.webContents.id !== sender.id)
      throw new Error("没有当前窗口的导出结果");
    shell.showItemInFolder(path);
  });
}
