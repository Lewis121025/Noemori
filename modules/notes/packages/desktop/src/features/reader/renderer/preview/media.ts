/**
 * 笔记里的图片地址：远程原样用，库内文件读字节再变成 blob URL。
 * 解析层只复用文件名判断，不碰 DOM。
 */

import type { ReaderApi } from "../../shared/api";

export type MediaKind = "md" | "wiki";

/** 注入点，便于测试；由阅读器桥接与 URL.createObjectURL 提供能力。 */
export type MediaIo = {
  resolveLink: (from: string, raw: string, kind: MediaKind) => Promise<string | null>;
  readFile: (rel: string) => Promise<Uint8Array>;
  createUrl: (bytes: Uint8Array, mime: string) => string;
  /** 只读嵌入按目标文件刷新；测试或静态预览可不提供监听。 */
  watchFile?: (path: string, changed: () => void) => () => void;
};

/**
 * 按链接目标选择嵌入预览；真实磁盘路径应直接使用 mimeFromPath。
 * @param src Markdown 或 Wiki 引用，可带查询参数和片段。
 * @returns 可预览的嵌入类型；其他目标返回 null。
 */
export function previewKindFromReference(src: string): "image" | "pdf" | "audio" | "video" | null {
  const path = src.split(/[?#]/, 1)[0] ?? src;
  return previewKindFromMime(mimeFromPath(path));
}

/** 按 MIME 选择嵌入节点；附件插入与链接解析共用同一规则。 */
export function previewKindFromMime(mime: string): "image" | "pdf" | "audio" | "video" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return mime === "application/pdf" ? "pdf" : null;
}

/**
 * 库内音视频的流式地址；主进程按 Range 从磁盘读取，不经 IPC 整块传输。
 *
 * @param rel 已解析的库内相对路径。
 */
export function vaultMediaUrl(rel: string): string {
  return `nous-vault://vault/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * 浏览器能直接当 img.src 的地址，不必读库。
 *
 * @param src Markdown url 或 HTML img src。
 */
export function isRemoteMediaSrc(src: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(src);
}

/**
 * 由真实文件扩展名选择 MIME，不将文件名里的 #、? 解释成 URL 后缀。
 * @param path 库内相对路径。
 * @returns 已支持的 MIME；其他类型返回 application/octet-stream。
 */
export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogv":
      return "video/ogg";
    default:
      return "application/octet-stream";
  }
}

/**
 * 把笔记里的图片地址变成 `<img>` 能加载的 URL。
 *
 * @param from 当前笔记的库内相对路径。
 * @param src 节点或标签上的原文地址。
 * @param kind wiki 按文件名解析，md 按相对路径拼接。
 * @param io 解析与读文件。
 * @returns 可赋给 img.src 的地址；找不到文件时为 `null`。
 */
export async function resolveMediaUrl(
  from: string,
  src: string,
  kind: MediaKind,
  io: MediaIo,
): Promise<string | null> {
  const trimmed = src.trim();
  if (trimmed === "") {
    return null;
  }
  if (isRemoteMediaSrc(trimmed)) {
    return trimmed;
  }
  try {
    const rel = await io.resolveLink(from, trimmed, kind);
    if (rel === null) {
      return null;
    }
    const bytes = await io.readFile(rel);
    return io.createUrl(bytes, mimeFromPath(rel));
  } catch {
    return null;
  }
}

/**
 * 渲染进程使用的 IO：走 IPC，blob 只活在当前页。
 * @param api 由阅读器入口注入的文件与链接能力。
 * @returns 资源访问接口；解析与读取失败由调用方处理。
 */
export function createBrowserMediaIo(
  api: Pick<ReaderApi, "linksResolve" | "fileRead"> &
    Partial<Pick<ReaderApi, "subscribeVaultChanged">>,
): MediaIo {
  return {
    // 媒体加载只认唯一解析；歧义与死链按不可加载处理，锚点对媒体无意义。
    resolveLink: async (from, raw, kind) => {
      const target = await api.linksResolve(from, raw, kind);
      return target.status === "resolved" ? target.path : null;
    },
    readFile: (rel) => api.fileRead(rel),
    watchFile: (path, changed) =>
      api.subscribeVaultChanged?.((event) => {
        if (event.paths.includes(path)) changed();
      }) ?? (() => {}),
    createUrl: (bytes, mime) => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
    },
  };
}

/**
 * 把消毒后的 HTML 里相对路径 img 换成可加载 URL。
 * 远程地址不动；失败的 src 清空，避免打到 vite 开发服务器。
 *
 * @param root 已挂到页面的消毒 DOM。
 * @param load 相对 src → 可加载 URL。
 * @returns 全部图片处理完毕；单张图片读取失败时清空地址，继续处理其余图片。
 */
export async function rewriteMediaSrcs(
  root: ParentNode,
  load: (src: string) => Promise<string | null>,
): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    if (src === "" || isRemoteMediaSrc(src)) {
      continue;
    }
    let url: string | null;
    try {
      url = await load(src);
    } catch {
      url = null;
    }
    if (url === null) {
      img.removeAttribute("src");
      continue;
    }
    img.setAttribute("src", url);
  }
}
