import type { VaultEntry } from "../../shared/api";

/** 显示笔记词干，其他附件保留扩展名；完整路径仍是文件身份。 */
export function libraryTitle(entry: VaultEntry): string {
  const name = entry.path.split("/").at(-1) ?? entry.path;
  return entry.kind === "file" ? name.replace(/\.(?:md|noemoriboard)$/iu, "") : name;
}
