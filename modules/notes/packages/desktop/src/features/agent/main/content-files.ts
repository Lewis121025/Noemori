import { attachmentImage } from "./attachment-images";
import type { ContentPreview } from "../shared/content";
import { mimeFromPath } from "../../reader/shared/media-kind";

/**
 * @param name 原始文件名，仅用于识别 HTML/SVG，不参与文件读取。
 * @param bytes 已完成归属与大小校验的不可变快照。
 * @returns PDF 原始字节、规范图片或有界正文；未知二进制保留文件占位。
 * @throws 已识别图片损坏或解码预算超限时拒绝，不把损坏图片伪装成文本。
 */
export function previewContentBytes(name: string, bytes: Buffer): ContentPreview {
  const mime = mimeFromPath(name);
  if (mime.startsWith("audio/")) return { type: "audio", mime, bytes: new Uint8Array(bytes) };
  if (mime.startsWith("video/")) return { type: "video", mime, bytes: new Uint8Array(bytes) };
  if (bytes.subarray(0, 5).toString() === "%PDF-")
    return { type: "pdf", bytes: new Uint8Array(bytes) };
  const image = attachmentImage(bytes);
  if (image)
    return {
      type: "image",
      url: `data:image/${image.format};base64,${image.bytes.toString("base64")}`,
    };
  const html = /\.html?$/iu.test(name);
  if (html && bytes.length > 2 * 1024 * 1024) return { type: "file" };
  if (bytes.subarray(0, 128 * 1024).includes(0)) return { type: "file" };
  try {
    const limit = html ? bytes.length : 128 * 1024;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, limit), {
      stream: bytes.length > limit,
    });
    if (html) return { type: "html", text };
    if (/\.svg$/iu.test(name) && /<svg[\s>]/u.test(text))
      return { type: "image", url: `data:image/svg+xml;base64,${bytes.toString("base64")}` };
    return { type: "text", text, truncated: bytes.length > limit };
  } catch {
    return { type: "file" };
  }
}
