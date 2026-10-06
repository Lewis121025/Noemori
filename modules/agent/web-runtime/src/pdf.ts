import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { getDocument, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { trimText, type Limits, type ReadResult, type PageImage } from "./contract.js";

/** 配对的原生画布及绘图上下文，尺寸与销毁属于同一个 PDF 渲染资源。 */
type Surface = { canvas: Canvas; context: SKRSContext2D };

// 与 PDF.js 的 Node CanvasFactory 契约一致，避免将画布强转成浏览器 HTMLCanvasElement。
class NodeCanvasFactory {
  create(width: number, height: number): Surface {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(surface: Surface, width: number, height: number): void {
    surface.canvas.width = width;
    surface.canvas.height = height;
  }
  destroy(surface: Surface): void {
    surface.canvas.width = 0;
    surface.canvas.height = 0;
  }
}

/**
 * 提取 PDF 文本并渲染前若干页，避免带页码或水印的扫描页被误判，不调用 OCR。
 * @param bytes 已有界下载的 PDF。
 * @param url 来源 URL。
 * @param limits 正文、页数与图像尺寸边界。
 * @returns 按原页码排列的正文和图片，并明确说明未返回的部分。
 * @throws PDF 损坏、加密、渲染失败或没有内容时抛出具体错误。
 */
export async function readPdf(bytes: Uint8Array, url: string, limits: Limits): Promise<ReadResult> {
  const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const task = getDocument({
    data: bytes,
    cMapUrl: join(root, "cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts/"),
    wasmUrl: join(root, "wasm/"),
    CanvasFactory: NodeCanvasFactory,
    useSystemFonts: false,
  });
  const images: PageImage[] = [];
  const sections: string[] = [];
  let truncated = false;
  let title: string | undefined;
  try {
    const pdf = await task.promise;
    const metadata = await pdf.getMetadata();
    if (
      typeof metadata.info === "object" &&
      metadata.info !== null &&
      "Title" in metadata.info &&
      typeof metadata.info.Title === "string" &&
      metadata.info.Title.trim()
    )
      title = metadata.info.Title.trim();
    let textLength = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const text = await pageText(page);
        if (text && textLength <= limits.max_chars) {
          const section = `## 第 ${number} 页\n\n${text}`;
          sections.push(section);
          textLength += Array.from(section).length;
        }
        if (number <= limits.max_pages) images.push(await renderPage(page, number, limits));
        else truncated = true;
        if (textLength > limits.max_chars && number >= Math.min(pdf.numPages, limits.max_pages)) {
          truncated = true;
          break;
        }
      } finally {
        page.cleanup();
      }
    }
    const limited = trimText(sections.join("\n\n"), limits.max_chars);
    if (!limited.text && images.length === 0) throw new Error("PDF 没有可读取的文字或页图");
    return {
      ...(title ? { title } : {}),
      url,
      text: limited.text,
      truncated: truncated || limited.truncated,
      warnings:
        pdf.numPages > limits.max_pages
          ? [`PDF 仅返回前 ${limits.max_pages} 页图像，后续视觉内容未返回`]
          : [],
      images,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF 读取失败：${reason}`);
  } finally {
    await task.destroy();
  }
}

async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items)
    if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
  return text.trim();
}

async function renderPage(page: PDFPageProxy, number: number, limits: Limits): Promise<PageImage> {
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(3, limits.image_edge / Math.max(viewport.width, viewport.height));
  const sized = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const target = factory.create(Math.ceil(sized.width), Math.ceil(sized.height));
  try {
    await page.render({ canvas: null, canvasContext: target.context, viewport: sized }).promise;
    const data = target.canvas.toBuffer("image/jpeg", 90);
    if (data.length > 5 * 1024 * 1024) throw new Error(`PDF 第 ${number} 页图像超过 5 MiB 上限`);
    return { page: number, format: "jpeg", data: data.toString("base64") };
  } finally {
    factory.destroy(target);
  }
}
