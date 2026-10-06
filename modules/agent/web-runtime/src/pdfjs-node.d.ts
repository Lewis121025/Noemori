import type { SKRSContext2D } from "@napi-rs/canvas";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils.js";
import type { RenderTask } from "pdfjs-dist/types/src/display/api.js";

// PDF.js 官方支持 Node 画布，但发布声明仅列出 DOM 上下文；补齐真实的 Node 调用签名。
declare module "pdfjs-dist/types/src/display/api.js" {
  interface PDFPageProxy {
    render(parameters: {
      canvas: null;
      canvasContext: SKRSContext2D;
      viewport: PageViewport;
    }): RenderTask;
  }
}
