import { mimeFromPath } from "../media/media";

/** 文本才携带可编辑源码；附件始终保留原始字节。 */
export type FileContent =
  | { kind: "markdown"; source: string; recovery?: string }
  | { kind: "text"; source: string }
  | { kind: "image" | "pdf" | "unsupported"; bytes: Uint8Array };

/**
 * 按预览类型分流；只有无二进制控制字符的有效 UTF-8 才允许编辑。
 * @param path 库内相对路径。
 * @param bytes 文件原始内容，不会被转移或修改。
 * @returns 文本源码或只读附件，解码失败时保留字节供明确提示。
 */
export function readFileContent(path: string, bytes: Uint8Array): FileContent {
  const mime = mimeFromPath(path);
  if (mime.startsWith("image/")) return { kind: "image", bytes };
  if (mime === "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    return { kind: "pdf", bytes };
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // TAB、换行、回车和换页在文本中合法，其余 C0 控制符视为二进制。
    if (/[^\t\n\f\r\u0020-\u{10ffff}]/u.test(source)) return { kind: "unsupported", bytes };
    return { kind: path.toLowerCase().endsWith(".md") ? "markdown" : "text", source };
  } catch {
    return { kind: "unsupported", bytes };
  }
}
