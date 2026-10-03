import { mimeFromPath } from "../preview/media";
import {
  isWhiteboardPath,
  parseWhiteboard,
  type WhiteboardDocument,
} from "../../shared/whiteboard/model";

/** 文本才携带可编辑源码；附件始终保留原始字节。 */
export type FileContent =
  | { kind: "markdown"; source: string; recovery?: string }
  | { kind: "text"; source: string }
  | { kind: "whiteboard"; board: WhiteboardDocument }
  | { kind: "image" | "pdf" | "unsupported"; bytes: Uint8Array };

/**
 * 按预览类型分流；只有无二进制控制字符的有效 UTF-8 才允许编辑。
 * @param path 库内相对路径。
 * @param bytes 文件原始内容，不会被转移或修改。
 * @returns 文本源码或只读附件，解码失败时保留字节供明确提示。
 * @throws 白板版本、结构或 UTF-8 无效时拒绝打开，避免把损坏文件替换为空白内容。
 */
export function readFileContent(path: string, bytes: Uint8Array): FileContent {
  if (isWhiteboardPath(path)) {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "whiteboard", board: parseWhiteboard(source) };
  }
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

/** 可编辑内容共用保存、冲突和恢复契约；预览附件不产生写入。 */
export function isEditableContent(content: FileContent | null): boolean {
  return content?.kind === "markdown" || content?.kind === "text" || content?.kind === "whiteboard";
}
