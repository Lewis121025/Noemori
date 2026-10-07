import { mimeFromPath } from "../preview/media";
import type { VaultEntry } from "../../shared/api";
import { isWhiteboardPath } from "../../shared/whiteboard/model";

/**
 * 为直接落笔选取未占用的本地路径，不创建或覆盖文件。
 * @param entries 当前库的完整条目，用于避开文件与目录重名。
 * @param parent 已存在的库内相对目录，空串表示库根。
 * @returns 可尝试创建的 Markdown 路径；外部进程竞争仍由内核独占创建检查。
 */
export function untitledNotePath(entries: readonly VaultEntry[], parent: string): string {
  return availableDocumentPath(entries, parent, "未命名", ".md");
}

/**
 * 为白板选取同目录未占用的名称，与笔记共用文件和目录冲突规则。
 * @param entries 库内完整条目；包含同名目录。
 * @param parent 已存在的相对目录，空串表示库根。
 * @returns 待独占创建的白板路径；本函数不读写磁盘。
 */
export function untitledWhiteboardPath(entries: readonly VaultEntry[], parent: string): string {
  return availableDocumentPath(entries, parent, "白板", ".noemoriboard");
}

function availableDocumentPath(
  entries: readonly VaultEntry[],
  parent: string,
  stem: string,
  extension: string,
): string {
  const occupied = new Set(entries.map((entry) => entry.path.toLocaleLowerCase()));
  for (let index = 1; ; index++) {
    const name = `${stem}${index === 1 ? "" : ` ${index}`}${extension}`;
    const path = parent === "" ? name : `${parent}/${name}`;
    if (!occupied.has(path.toLocaleLowerCase())) return path;
  }
}

/**
 * 生成面向用户的资料类型名称，避免浏览列表触发整库读盘。
 * @param entry 已验证的库内文件或目录条目。
 * @returns 基于目录类型与扩展名的展示名称；本函数不访问磁盘。
 */
export function libraryEntryKind(entry: VaultEntry): string {
  if (entry.kind === "directory") return "文件夹";
  if (isWhiteboardPath(entry.path)) return "白板";
  if (entry.path.toLowerCase().endsWith(".md")) return "笔记";
  const mime = mimeFromPath(entry.path);
  if (mime.startsWith("image/")) return "图片";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/")) return "视频";
  return "文件";
}
