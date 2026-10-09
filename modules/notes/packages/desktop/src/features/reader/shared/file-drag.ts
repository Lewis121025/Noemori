import type { VaultEntry } from "./api";
import { isEntryPath } from "./file-browser";

/** 文件身份与普通选中文字分开传递，接收方不能把路径误当正文引用。 */
export const LIBRARY_ENTRIES_MIME = "application/x-noemori-library-entries";

/** 库归属在拖拽开始时捕获；条目只携带相对路径和种类，不授予任意磁盘访问。 */
export type LibraryEntriesDrag = { root: string; entries: Pick<VaultEntry, "path" | "kind">[] };

/**
 * @param value 拖拽或 IPC 的未验证载荷。
 * @returns 独立的库归属和条目列表；实际库归属仍须由主进程核对。
 * @throws 缺失身份、非法路径、重复条目或超大载荷时拒绝，不退化为文本引用。
 */
export function parseLibraryEntriesDrag(value: unknown): LibraryEntriesDrag {
  if (
    typeof value !== "object" ||
    value === null ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !value.root ||
    value.root.length > 16384 ||
    !("entries" in value) ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > 10000
  )
    throw new Error("笔记库文件拖拽无效");
  const entries = value.entries.map((entry: unknown): LibraryEntriesDrag["entries"][number] => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !isEntryPath(entry.path) ||
      entry.path.length > 16384 ||
      !("kind" in entry) ||
      (entry.kind !== "file" && entry.kind !== "directory")
    )
      throw new Error("笔记库文件拖拽路径无效");
    return { path: entry.path, kind: entry.kind };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("笔记库文件拖拽条目重复");
  return { root: value.root, entries };
}
