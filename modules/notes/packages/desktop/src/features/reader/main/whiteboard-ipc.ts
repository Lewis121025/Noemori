import { ipcMain, type WebContents, type BrowserWindow } from "electron";
import { parseShapeRepairRequest } from "../shared/whiteboard/recognition";
import { createWhiteboardProcessor, type WhiteboardProcessor } from "./whiteboard-processor";
import type { ShapeRepair } from "../shared/whiteboard/recognition";

/** 注册后台几何修复；仅主窗口可请求，完整观测与缩放统一校验，失败向上传播。 */
export function registerWhiteboardIpc(
  getWindow: () => BrowserWindow | null,
  repair?: ShapeRepair,
): void {
  let processor: WhiteboardProcessor | null = null,
    owner: WebContents | null = null;
  ipcMain.handle("reader.whiteboard.repair", (event, value: unknown) => {
    const contents = getWindow()?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    )
      throw new Error("图形修复请求来源无效");
    const request = parseShapeRepairRequest(value);
    if (repair) return repair(request);
    if (owner !== contents) {
      if (processor) void processor.close();
      owner = contents;
      const next = createWhiteboardProcessor();
      processor = next;
      contents.once("destroyed", () => {
        void next.close();
        if (processor === next) {
          processor = null;
          owner = null;
        }
      });
    }
    return processor!.repair(request);
  });
}
