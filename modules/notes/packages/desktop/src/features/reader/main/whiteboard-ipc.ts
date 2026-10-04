import { ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";
import type { NativeInk } from "@noemori/vault-node";
import { parseRecognitionPoints, parseShapePrediction } from "../shared/whiteboard/recognition";

/** 注册停笔识别的受限入口；仅主窗口可请求，模型路径由宿主固定，推理错误向上传播。 */
export function registerWhiteboardIpc(getWindow: () => BrowserWindow | null): void {
  let classifier: NativeInk | null = null;
  ipcMain.handle("reader.whiteboard.recognize", async (event, value: unknown) => {
    const contents = getWindow()?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    )
      throw new Error("图形识别请求来源无效");
    const points = parseRecognitionPoints(value);
    if (!classifier) {
      const { NativeInk } = await import("@noemori/vault-node");
      classifier ??= new NativeInk(join(__dirname, "ink", "model.onnx"));
    }
    return parseShapePrediction(await classifier.classify(points.flatMap((p) => [p.x, p.y])));
  });
}
