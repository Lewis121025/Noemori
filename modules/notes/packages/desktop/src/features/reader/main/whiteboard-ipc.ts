import { ipcMain, type BrowserWindow } from "electron";
import { parseShapeRepairRequest } from "../shared/whiteboard/recognition";
import { repairShape } from "../shared/whiteboard/fitting";

/** 注册后台几何修复；仅主窗口可请求，完整观测与缩放统一校验，失败向上传播。 */
export function registerWhiteboardIpc(getWindow: () => BrowserWindow | null): void {
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
    return repairShape(request.points, request.scale, request.observations);
  });
}
