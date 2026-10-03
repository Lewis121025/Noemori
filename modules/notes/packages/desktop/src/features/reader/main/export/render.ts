import { isUint8Array } from "node:util/types";
import { BrowserWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PdfExportLinks } from "./pdf";
import type { ExportComputation } from "./computation";
import { EXPORT_LIMITS } from "../../shared/export";
import type {
  ExportRenderRequest,
  ExportRenderReply,
  ExportAnchor,
} from "../../shared/export-render";

/** 资源转换只依赖有限渲染能力，测试无需安装实际窗口。 */
export type ExportRenderer = {
  render: (request: ExportRenderRequest) => Promise<ExportRenderReply>;
  pdf: (doc: unknown, anchors: ExportAnchor[], links?: PdfExportLinks) => Promise<Uint8Array>;
};

/** 校验隔离页面的回复，崩溃或错误返回不能变成空白产物。 */
export function parseRenderReply(value: unknown): ExportRenderReply {
  if (typeof value !== "object" || value === null || !("kind" in value))
    throw new Error("导出渲染响应无效");
  if (value.kind === "ready") return { kind: "ready" };
  if (value.kind === "svg" && "svg" in value && typeof value.svg === "string")
    return { kind: "svg", svg: value.svg };
  if (value.kind === "html" && "doc" in value) return { kind: "html", doc: value.doc };
  if (
    value.kind === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "width" in value &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    "height" in value &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  )
    return { kind: "image", data: value.data, width: value.width, height: value.height };
  throw new Error("导出渲染响应缺少有效内容");
}

/**
 * 创建不含 Node、preload 和外部网络的临时渲染窗口。
 * @param signal 用户取消与宿主生命周期信号。
 * @returns 有界、串行调用的渲染能力；每次调用结束必定销毁窗口。
 * @throws 取消、超时、渲染崩溃、资源或打印错误原样传播。
 */
export function createExportRenderer(
  signal: AbortSignal,
  compute: ExportComputation,
): ExportRenderer {
  const developmentUrl = process.env["ELECTRON_RENDERER_URL"];
  const pageUrl = developmentUrl
    ? new URL("export.html", developmentUrl).href
    : pathToFileURL(join(__dirname, "../renderer/export.html")).href;
  const developmentOrigin = developmentUrl ? new URL(pageUrl).origin : null;
  const applicationResources = new Set(["mainFrame", "script", "stylesheet", "font", "xhr"]);
  function run(request: ExportRenderRequest, print: false): Promise<ExportRenderReply>;
  function run(request: ExportRenderRequest, print: true): Promise<Uint8Array>;
  async function run(
    request: ExportRenderRequest,
    print: boolean,
  ): Promise<ExportRenderReply | Uint8Array> {
    signal.throwIfAborted();
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1000,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        partition: "noemori-export",
      },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        // 开发服务器承载应用模块；文档图片和媒体仍必须来自冻结后的资源。
        const applicationAsset =
          developmentOrigin !== null &&
          applicationResources.has(details.resourceType) &&
          new URL(details.url).origin === developmentOrigin;
        callback({ cancel: !applicationAsset });
      },
    );
    let rejectStopped: (reason: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const abort = () => rejectStopped(new Error("导出已取消"));
    const gone = () => rejectStopped(new Error("导出渲染进程意外退出"));
    signal.addEventListener("abort", abort, { once: true });
    contents.once("render-process-gone", gone);
    const timer = setTimeout(
      () => rejectStopped(new Error("文档转换超过 180 秒，已终止")),
      EXPORT_LIMITS.renderMs,
    );
    try {
      const work = async () => {
        if (developmentUrl) await window.loadURL(pageUrl);
        else await window.loadFile(join(__dirname, "../renderer/export.html"));
        // 传入的内容仅作为 JSON 字面量；固定入口不允许文档提供执行代码。
        const value: unknown = await contents.executeJavaScript(
          `window.noemoriExport(${JSON.stringify(request)})`,
        );
        const reply = parseRenderReply(value);
        if (!print) return reply;
        if (reply.kind !== "ready") throw new Error("打印前文档尚未就绪");
        return await contents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          pageSize: "A4",
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          generateTaggedPDF: true,
        });
      };
      return await Promise.race([work(), stopped]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      contents.removeListener("render-process-gone", gone);
      if (!window.isDestroyed()) window.destroy();
    }
  }
  return {
    render: (request) => run(request, false),
    pdf: async (doc, anchors, links = { links: [], destinations: [] }) => {
      const bytes = await run(
        { kind: "document", doc, anchors, destinations: [...links.destinations] },
        true,
      );
      const result = await compute({ kind: "finalizePdf", bytes, pageUrl, links });
      if (!isUint8Array(result)) throw new Error("PDF 校验响应无效");
      return result;
    },
  };
}
