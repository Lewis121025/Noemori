import { ipcMain } from "electron";
import { parseEntryBatchId, parseEntryBatchRequest } from "../shared/entry-batch";
import { parsePathArgument } from "../shared/reader-protocol";
import { EntryBatchControl } from "./entry-batch-control";
import type { ReaderClient } from "./ipc";

/**
 * 将同步内核的批次进度与停止信号接到 IPC；按窗口、库根和批次编号限定归属。
 * 停止走共享原子位，因此不会排在正在执行的批次后面；结束或窗口销毁后清理订阅。
 * @throws 重复提交和无效请求在入队前拒绝，内核失败保持原始拒绝结果。
 */
export function registerEntryBatchIpc(core: ReaderClient): void {
  const active = new Map<number, { id: string; root: string; control: EntryBatchControl }>();
  ipcMain.handle("reader.entry.batch", async ({ sender }, value: unknown, batchId: unknown) => {
    const request = parseEntryBatchRequest(value);
    const id = parseEntryBatchId(batchId);
    if (active.has(sender.id)) throw new Error("正在处理批量操作，请等待当前批次结束");
    const control = new EntryBatchControl();
    control.start(request.paths.length);
    active.set(sender.id, { id, root: request.root, control });
    let previous = "";
    const report = (): void => {
      const progress = control.progress;
      const version = `${progress.phase}:${progress.completed}:${progress.total}`;
      if (version === previous || sender.isDestroyed()) return;
      previous = version;
      sender.send("reader.entry.batch.progress", id, progress);
    };
    const stop = (): void => control.stop();
    sender.once("destroyed", stop);
    const timer = setInterval(report, 80);
    timer.unref();
    try {
      report();
      return await core.call("entryBatch", request, control.buffer);
    } finally {
      clearInterval(timer);
      sender.removeListener("destroyed", stop);
      active.delete(sender.id);
    }
  });
  ipcMain.handle("reader.entry.batch.stop", ({ sender }, root: unknown, batchId: unknown) => {
    const path = parsePathArgument(root);
    const id = parseEntryBatchId(batchId);
    const batch = active.get(sender.id);
    if (batch?.id === id && batch.root === path) batch.control.stop();
  });
}
