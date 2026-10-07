import type { VaultEntry } from "../../shared/api";
import type { FilePresentation } from "../../shared/file-browser";
import {
  ancestorDirectories,
  buildFileTree,
  type FileTreeNode,
  type FileTreeRow,
} from "./file-tree";

const compare = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** 显示笔记词干，其他附件保留扩展名；完整路径仍是文件身份。 */
export function libraryTitle(entry: VaultEntry): string {
  const name = entry.path.split("/").at(-1) ?? entry.path;
  return entry.kind === "file" ? name.replace(/\.(?:md|noemoriboard)$/iu, "") : name;
}

/**
 * 生成浏览和搜索共用的层级顺序，搜索只保留命中与祖先，空目录仍可浏览。
 * @param entries 当前库清单，不修改输入。
 * @param expanded 浏览时展开的目录。
 * @param sort 同级文件的排序；目录始终按自然名称排列。
 * @param matches 已命中的完整路径；缺省表示浏览，空集合表示无结果。
 * @param closed 搜索期间手动折叠的分支，与持久化浏览现场相互独立。
 * @returns 含辅助技术层级信息的可见行；恢复专区的条目不参与。
 */
export function libraryTreeRows(
  entries: readonly VaultEntry[],
  expanded: ReadonlySet<string>,
  sort: FilePresentation["sort"],
  matches?: ReadonlySet<string>,
  closed: ReadonlySet<string> = new Set(),
): FileTreeRow[] {
  const retained =
    matches === undefined
      ? null
      : new Set([...matches].flatMap((path) => [path, ...ancestorDirectories(path)]));
  const tree = buildFileTree(
    entries.filter(
      (entry) => !entry.recoveryOnly && (retained === null || retained.has(entry.path)),
    ),
  );
  const rows: FileTreeRow[] = [];
  function visit(nodes: FileTreeNode[], parent: string | null, depth: number): void {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
      if (a.kind === "file" && sort === "modified") {
        const difference = (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
        if (difference) return difference;
      }
      const order =
        compare.compare(libraryTitle(a), libraryTitle(b)) || compare.compare(a.path, b.path);
      return a.kind === "file" && sort === "name-desc" ? -order : order;
    });
    nodes.forEach((node, index) => {
      rows.push({ node, parent, depth, position: index + 1, siblings: nodes.length });
      if (matches === undefined ? expanded.has(node.path) : !closed.has(node.path))
        visit(node.children, node.path, depth + 1);
    });
  }
  visit(tree, null, 0);
  return rows;
}
