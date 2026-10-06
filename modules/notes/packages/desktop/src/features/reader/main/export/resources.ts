import { isUint8Array } from "node:util/types";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { EXPORT_LIMITS } from "../../shared/export";
import { checkExportImage } from "../../shared/export-image";
import { mimeFromPath } from "../../shared/media-kind";
import { parseWhiteboard } from "../../shared/whiteboard/model";
import { inkBounds, strokePath } from "../../shared/whiteboard/geometry";
import type { ExportRenderer } from "./render";
import type { NativeExport } from "./native";
import type { ExportComputation } from "./computation";

/** 冻结图片以实际内容命名，确保同内容资源去重且输出路径稳定。 */
function resourceName(bytes: Uint8Array, extension: string): string {
  return `resources/${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
}

/** 只接受本任务按内容摘要生成的资源名，返回独立内容校验使用的 SHA-256。 */
export function exportResourceHash(path: string): string {
  const match = /resources\/([a-f0-9]{64})\.([a-z0-9]+)/i.exec(path);
  const hash = match?.[1];
  if (!match || match[0] !== path || !hash) throw new Error("DOCX 图片不属于冻结资源");
  return hash.toLowerCase();
}

/**
 * SVG 始终保留世界坐标与完整笔宽；文档嵌入只调整矢量显示尺寸，不裁切或重采样笔迹。
 * 独立 SVG／PNG 使用原尺寸，PNG 超预算仍须明确拒绝。
 */
export function whiteboardSvg(source: string, layout: "native" | "document" = "native"): string {
  const board = parseWhiteboard(source);
  const bounds = inkBounds(board.strokes);
  const box =
    bounds === null
      ? { x: 0, y: 0, width: 640, height: 300 }
      : {
          x: bounds.x - 24,
          y: bounds.y - 24,
          width: Math.max(1, bounds.width + 48),
          height: Math.max(1, bounds.height + 48),
        };
  // Word 的双倍栅格预览也使用同一个矢量显示尺寸；所有原始坐标仍保存在 viewBox 内。
  const scale =
    layout === "native"
      ? 1
      : Math.min(
          1,
          EXPORT_LIMITS.imageEdge / (2 * box.width),
          EXPORT_LIMITS.imageEdge / (2 * box.height),
          Math.sqrt(EXPORT_LIMITS.imagePixels / (4 * box.width * box.height)),
        );
  const width = scale === 1 ? box.width : Math.max(1, Math.floor(box.width * scale));
  const height = scale === 1 ? box.height : Math.max(1, Math.floor(box.height * scale));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="white"/>${board.strokes.map((stroke) => `<path d="${strokePath(stroke.points)}" fill="none" stroke="#171717" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</svg>`;
}

/** 数据 URL 必须明确是图片，解码之后还由隔离页面验证真实格式与尺寸。 */
export function decodeImageData(source: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match) throw new Error("图片数据地址格式无效");
  const mime = match[1];
  const payload = match[3];
  if (mime === undefined || payload === undefined || payload === "")
    throw new Error("图片数据地址为空");
  if (payload.length > EXPORT_LIMITS.memoryBytes) throw new Error("图片数据超过任务内存预算");
  const encoded = match[2] ? decodeURIComponent(payload).replace(/[\t\n\f\r ]/g, "") : payload;
  if (
    match[2] &&
    (!encoded ||
      !/^[a-z0-9+/]*={0,2}$/i.test(encoded) ||
      encoded.length % 4 === 1 ||
      (encoded.includes("=") && encoded.length % 4 !== 0))
  )
    throw new Error("图片 Base64 数据无效");
  const bytes = match[2]
    ? Buffer.from(encoded, "base64")
    : Buffer.from(decodeURIComponent(payload));
  if (bytes.byteLength >= EXPORT_LIMITS.memoryBytes) throw new Error("图片数据超过任务内存预算");
  return { bytes, mime };
}

/** 资源的包内位置及显示尺寸；栅格像素预算在生成时独立验证。 */
export type ExportImage = { path: string; mime: string; width: number; height: number };

/** 网络与本地资源统一冻结、校验、去重；任何失败都由整批事务处理。 */
export class ExportResources {
  readonly images = new Map<string, ExportImage>();
  readonly downloads: { url: string; path: string }[] = [];
  readonly attachments = new Map<string, string>();
  private readonly cache = new Map<string, Promise<ExportImage>>();
  private readonly staged = new Map<string, Promise<void>>();
  private readonly remote = new Map<string, Promise<{ path: string; mime: string }>>();

  /** @param native 有限任务能力；renderer 为隔离渲染器；signal 负责中断网络读取。 */
  constructor(
    private readonly native: NativeExport,
    private readonly renderer: ExportRenderer,
    private readonly signal: AbortSignal,
    private readonly compute: ExportComputation,
  ) {}

  /** 下载最多四项并立即冻结到磁盘；全部下载结束后才返回，转换仍由调用方串行进行。 */
  async prefetchImages(sources: readonly string[]): Promise<void> {
    const pending = [...new Set(sources.filter((source) => /^https?:/i.test(source)))];
    let next = 0;
    let failed = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed && next < pending.length) {
        const source = pending[next++];
        if (source === undefined) throw new Error("图片下载队列身份无效");
        try {
          await this.freezeDownload(source);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EXPORT_LIMITS.downloadConcurrency, pending.length) }, worker),
    );
    if (failed) throw failure;
  }

  private freezeDownload(source: string): Promise<{ path: string; mime: string }> {
    const prior = this.remote.get(source);
    if (prior) return prior;
    const work = async () => {
      this.signal.throwIfAborted();
      const { bytes, mime } = await downloadImage(source, this.signal);
      checkExportImage(bytes, mime);
      const path = `working/remote/${createHash("sha256").update(bytes).digest("hex")}`;
      await this.stageOnce(path, () => this.native.write(path, bytes, true));
      return { path, mime };
    };
    const result = work();
    this.remote.set(source, result);
    return result;
  }

  private stageOnce(path: string, write: () => Promise<void>): Promise<void> {
    const prior = this.staged.get(path);
    if (prior) return prior;
    const result = write();
    this.staged.set(path, result);
    return result;
  }

  /** 获取已冻结的图片；Word 需要可靠栅格资源时将 SVG 转换为 PNG。 */
  image(pathOrUrl: string, word = false): Promise<ExportImage> {
    // data URL 可包含整个图片；缓存身份只保留摘要，正文释放后不继续占用图片字符串。
    const key = `${word ? "word:" : "image:"}${createHash("sha256").update(pathOrUrl).digest("hex")}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const work = this.loadImage(pathOrUrl, word);
    this.cache.set(key, work);
    return work;
  }

  private async loadImage(source: string, word: boolean): Promise<ExportImage> {
    this.signal.throwIfAborted();
    let bytes: Uint8Array;
    let mime: string;
    const remote = /^https?:/i.test(source);
    if (source.startsWith("data:")) ({ bytes, mime } = decodeImageData(source));
    else if (remote) {
      const frozen = await this.freezeDownload(source);
      bytes = await this.native.readOutput(frozen.path);
      mime = frozen.mime;
    } else {
      await this.native.include(source);
      bytes = await this.native.read(source);
      mime = mimeFromPath(source);
    }
    const frozen =
      remote && word && mime === "image/svg+xml" ? await this.stageImage(bytes, mime) : null;
    const image = await this.stageImage(bytes, mime, word);
    if (remote) this.downloads.push({ url: source, path: frozen?.path ?? image.path });
    return image;
  }

  /** 保存经过像素预算校验的图片，禁止损坏资源或外部 SVG 依赖进入结果。 */
  async stageImage(
    bytes: Uint8Array,
    mime: string,
    word = false,
    resource = false,
  ): Promise<ExportImage> {
    if (!mime.startsWith("image/")) throw new Error(`附件不是可显示的图片：${mime}`);
    checkExportImage(bytes, mime);
    const data = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    const result = await this.renderer.render({
      kind: word && mime === "image/svg+xml" ? "raster" : "image",
      source: data,
      scale: 2,
    });
    if (result.kind !== "image") throw new Error("图片校验没有返回尺寸");
    if (
      result.width > EXPORT_LIMITS.imageEdge ||
      result.height > EXPORT_LIMITS.imageEdge ||
      result.width * result.height > EXPORT_LIMITS.imagePixels
    )
      throw new Error("图片像素数量超过预算");
    const decoded = decodeImageData(result.data);
    checkExportImage(decoded.bytes, decoded.mime);
    const extension =
      decoded.mime === "image/svg+xml"
        ? "svg"
        : decoded.mime === "image/jpeg"
          ? "jpg"
          : decoded.mime.slice(6).replace(/[^a-z0-9]/gi, "");
    const path = resourceName(decoded.bytes, extension);
    await this.stageOnce(path, () => this.native.write(path, decoded.bytes, resource));
    const scale = word && mime === "image/svg+xml" ? 2 : 1;
    const image = {
      path,
      mime: decoded.mime,
      width: result.width / scale,
      height: result.height / scale,
    };
    this.images.set(path, image);
    return image;
  }

  /** 每篇转换时才读取需要的图片，任务级缓存仅保留磁盘身份和尺寸。 */
  async imageData(path: string): Promise<string> {
    const image = this.images.get(path);
    if (!image) throw new Error("正文图片不属于本次导出资源");
    const bytes = await this.native.readOutput(path);
    return `data:${image.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  }

  /** 保留附件原始字节；同名附件使用内容摘要和原扩展名分离。 */
  async attachment(source: string): Promise<string> {
    const prior = this.attachments.get(source);
    if (prior) return prior;
    await this.native.include(source);
    const file = this.native.snapshot.files.find((entry) => entry.path === source);
    if (!file) throw new Error(`附件没有有效快照：${source}`);
    const extension = posix.extname(source).replace(/[^a-zA-Z0-9.]/g, "");
    const path = `resources/${file.hash}${extension}`;
    await this.stageOnce(path, () => this.native.copy(source, path));
    this.attachments.set(source, path);
    return path;
  }

  /** 将白板的原始世界坐标转换成独立资源。 */
  async board(source: string, word = false): Promise<ExportImage> {
    await this.native.include(source);
    const svg = await this.compute({
      kind: "whiteboard",
      bytes: await this.native.read(source),
      layout: "document",
    });
    if (!isUint8Array(svg)) throw new Error("白板转换响应无效");
    return this.stageImage(svg, "image/svg+xml", word);
  }

  /** 图表转换和普通图片共用校验与去重，SVG 不依赖外部样式。 */
  async diagram(source: string, word = false): Promise<ExportImage> {
    const result = await this.renderer.render({ kind: "mermaid", source });
    if (result.kind !== "svg") throw new Error("Mermaid 未生成 SVG");
    return this.stageImage(new TextEncoder().encode(result.svg), "image/svg+xml", word);
  }

  /** PDF 附件显示指定页并保留完整原文件；不依赖滚动进入视口。 */
  async pdf(source: string, page: number): Promise<{ image: ExportImage; attachment: string }> {
    const attachment = await this.attachment(source);
    const bytes = await this.native.read(source);
    const result = await this.renderer.render({ kind: "pdf", bytes: Array.from(bytes), page });
    if (result.kind !== "image") throw new Error("PDF 附件未生成预览");
    const decoded = decodeImageData(result.data);
    return { image: await this.stageImage(decoded.bytes, decoded.mime), attachment };
  }
}

/**
 * 下载用户正文引用的网络图片；重定向、时间和解压后的字节均受预算约束。
 * @throws 网络、格式、重定向、超时或取消失败；不使用用户浏览器凭据。
 */
export async function downloadImage(
  source: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("网络图片下载超过 30 秒")),
    EXPORT_LIMITS.downloadMs,
  );
  try {
    return await readDownload(source, controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/** 同一截止时间覆盖重定向和正文；流取消、大小或 MIME 失败都向任务层传播。 */
async function readDownload(
  source: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  let url = new URL(source);
  for (let redirects = 0; redirects <= EXPORT_LIMITS.redirects; redirects++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("网络图片地址不受支持");
    signal.throwIfAborted();
    const response = await fetch(url, { signal, redirect: "manual", credentials: "omit" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === EXPORT_LIMITS.redirects)
        throw new Error("网络图片重定向次数超限或地址缺失");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`网络图片下载失败：HTTP ${response.status}`);
    }
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!mime.startsWith("image/")) {
      await response.body?.cancel();
      throw new Error("网络响应不是图片");
    }
    if (!response.body) throw new Error("网络图片响应为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > EXPORT_LIMITS.resourceBytes) throw new Error("网络图片超过 64 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (length === 0) throw new Error("网络图片内容为空");
    signal.throwIfAborted();
    return { bytes: Buffer.concat(chunks, length), mime };
  }
  throw new Error("网络图片重定向次数超限");
}
