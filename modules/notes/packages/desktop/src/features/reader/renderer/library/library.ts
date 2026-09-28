import { toString } from "mdast-util-to-string";
import { markdownProcessor } from "../markdown/markdown-processor";
import { mimeFromPath } from "../preview/media";
import type { VaultEntry } from "../../shared/api";

/**
 * 为直接落笔选取未占用的本地路径，不创建或覆盖文件。
 * @param entries 当前库的完整条目，用于避开文件与目录重名。
 * @param parent 已存在的库内相对目录，空串表示库根。
 * @returns 可尝试创建的 Markdown 路径；外部进程竞争仍由内核独占创建检查。
 */
export function untitledNotePath(entries: readonly VaultEntry[], parent: string): string {
  const occupied = new Set(entries.map((entry) => entry.path.toLocaleLowerCase()));
  for (let index = 1; ; index++) {
    const name = `未命名${index === 1 ? "" : ` ${index}`}.md`;
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
  if (entry.path.toLowerCase().endsWith(".md")) return "笔记";
  const mime = mimeFromPath(entry.path);
  if (mime.startsWith("image/")) return "图片";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/")) return "视频";
  return "文件";
}

/**
 * 资料预览只提取有限的正文，不加载嵌入资源或运行文档中的内容。
 * @param source 磁盘 Markdown；上限截断仅作用于展示，不写回文件。
 * @returns 最多八段文本摘要；解析错误交给预览界面显示。
 */
export function libraryExcerpt(source: string): string[] {
  return markdownProcessor
    .parse(source.slice(0, 12000))
    .children.filter(
      (node) => node.type !== "yaml" && node.type !== "html" && node.type !== "definition",
    )
    .map((node) => toString(node).trim())
    .filter(Boolean)
    .slice(0, 8);
}
