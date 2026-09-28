import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// 当前 Electron 尚不具备 PDF.js 6 默认构建要求的集合 API，使用官方兼容构建。
GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 用副本交给 PDF 工作线程，避免转移编辑器持有的原始字节。
 * @param bytes 本地 PDF 内容。
 * @param onPassword 请求密码或报告密码错误，不记录密码。
 * @returns 可销毁的加载任务，解析失败由其 promise 报告。
 */
export function openPdf(
  bytes: Uint8Array,
  onPassword: (submit: (password: string) => void, incorrect: boolean) => void,
): PDFDocumentLoadingTask {
  const assets = new URL("./pdfjs/", window.location.href).href;
  const task = getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  });
  task.onPassword = (submit: (password: string) => void, reason: number) =>
    onPassword(submit, reason === PasswordResponses.INCORRECT_PASSWORD);
  return task;
}

/** 当前页的画布与可选中文字共用一次取消生命周期。 */
export type PdfPageRender = {
  /** 两层均完成才成功；任一层失败会取消其余工作，并保留原始错误。 */
  promise: Promise<void>;
  /** 可重复调用；全部工作退出后才释放画布和页面资源。 */
  cancel: () => void;
};

/**
 * 绘制一页；限制栅格内存，高倍率仍保留文本层的选择精度。
 * @param page 已解析的 PDF 页。
 * @param scale CSS 缩放比例。
 * @param host 当前渲染独占的容器，失败或取消时移除。
 * @returns 渲染结果与取消入口；调用方须处理失败并在换页时取消。
 * @throws 页面参数或 DOM 初始化无效时抛出；任务启动后的失败由 promise 报告。
 */
export function renderPdfPage(page: PDFPageProxy, scale: number, host: HTMLElement): PdfPageRender {
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(
    window.devicePixelRatio || 1,
    Math.sqrt(16_777_216 / (viewport.width * viewport.height)),
    8192 / viewport.width,
    8192 / viewport.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const text = document.createElement("div");
  text.className = "textLayer";
  host.style.width = `${viewport.width}px`;
  host.style.height = `${viewport.height}px`;
  host.style.setProperty("--total-scale-factor", String(scale));
  host.replaceChildren(canvas, text);
  let drawing: RenderTask | undefined;
  let textLayer: TextLayer | undefined;
  let cancelled = false;
  const tasks: Promise<unknown>[] = [];

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    drawing?.cancel();
    textLayer?.cancel();
    host.remove();
    // 初始化可能只启动了一层；只等待已经获得的任务，避免失败后留下后台工作。
    void Promise.allSettled(tasks).then(() => {
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    });
  }

  const promise = (async () => {
    try {
      drawing = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      tasks.push(drawing.promise);
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      tasks.push(textLayer.render());
      await Promise.all(tasks);
    } catch (cause) {
      cancel();
      throw cause;
    }
  })();
  return { promise, cancel };
}
