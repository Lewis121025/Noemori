import { isEntryPath } from "./file-browser";

/** 完整目录副本的实际位置；warning 只表示提交后的索引或附属数据问题。 */
export type DirectoryImportResult = {
  path: string;
  files: number;
  warning: string | null;
};

/** 已导入目录的原始归属，用于把文章对话与新的仓库路径接上。 */
export type ImportedLibrary = { source: string; path: string };

/** 验证库内父目录；根目录使用空字符串，非法路径在弹出系统选择框前拒绝。 */
export function parseImportParent(value: unknown): string {
  if (value !== "" && !isEntryPath(value)) throw new Error("导入目标目录无效");
  return value;
}

/** 完整校验提交结果，不能把响应缺失或损坏误判成没有执行导入。 */
export function parseDirectoryImportResult(value: unknown): DirectoryImportResult | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !("path" in value) ||
    !isEntryPath(value.path) ||
    !("files" in value) ||
    typeof value.files !== "number" ||
    !Number.isSafeInteger(value.files) ||
    value.files < 0 ||
    !("warning" in value) ||
    (value.warning !== null && typeof value.warning !== "string")
  )
    throw new Error("目录导入结果无效");
  return { path: value.path, files: value.files, warning: value.warning };
}

/** 验证旧库迁移归属；路径不合法时拒绝，防止对话接到错误的文章上。 */
export function parseImportedLibrary(value: unknown): ImportedLibrary {
  if (
    typeof value !== "object" ||
    value === null ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !value.source ||
    !("path" in value) ||
    !isEntryPath(value.path)
  )
    throw new Error("仓库迁移归属无效");
  return { source: value.source, path: value.path };
}
