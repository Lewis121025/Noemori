import type { VaultEntry } from "../../../shared/api";

/** 目录树节点以完整相对路径为身份，同名文件不会合并。 */
export type FileTreeNode = VaultEntry & { name: string; children: FileTreeNode[] };
/** 可见树行携带层级和同级位置，供键盘导航与辅助技术使用。 */
export type FileTreeRow = {
  node: FileTreeNode;
  depth: number;
  parent: string | null;
  position: number;
  siblings: number;
};
/** 仅在文件操作已提交后发布，供目录树跟随路径变化并恢复操作上下文。 */
export type FileEntryChange =
  | { action: "create"; entry: VaultEntry }
  | { action: "relocate"; from: string; entry: VaultEntry }
  | { action: "trash"; entry: VaultEntry };
const compare = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** @returns 文件名所在目录；顶层条目返回空字符串。 */
export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** @returns 从顶层到父级的目录路径，供恢复当前文档时自动展开。 */
export function ancestorDirectories(path: string | null): string[] {
  if (path === null) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * 按真实父子关系建立目录，目录优先、自然排序；草稿缺失的父目录作为虚拟目录显示。
 * @param entries 库内条目快照，调用方不得传入绝对路径或越界路径。
 * @returns 新目录树，不修改输入；重复条目按路径合并。
 */
export function buildFileTree(entries: VaultEntry[]): FileTreeNode[] {
  const nodes = new Map<string, FileTreeNode>();
  function ensure(path: string, kind: VaultEntry["kind"]): FileTreeNode {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FileTreeNode = {
      path,
      kind,
      name: path.slice(path.lastIndexOf("/") + 1),
      children: [],
    };
    nodes.set(path, node);
    const parent = parentDirectory(path);
    if (parent !== "") ensure(parent, "directory").children.push(node);
    return node;
  }
  for (const entry of entries) ensure(entry.path, entry.kind);
  const roots = [...nodes.values()].filter((node) => parentDirectory(node.path) === "");
  function sort(items: FileTreeNode[]): void {
    items.sort((a, b) =>
      a.kind === b.kind
        ? compare.compare(a.name, b.name) || a.path.localeCompare(b.path)
        : a.kind === "directory"
          ? -1
          : 1,
    );
    for (const node of items) sort(node.children);
  }
  sort(roots);
  return roots;
}

/**
 * 从完整目录树解析选中项，包含恢复草稿补出的父目录与已折叠的条目。
 * @param nodes 未经过搜索过滤的目录树。
 * @param path 选中路径，未选择时为 null。
 * @returns 匹配的节点；未选择或条目已移除时返回 null。
 */
export function findFileTreeNode(nodes: FileTreeNode[], path: string | null): FileTreeNode | null {
  if (path === null) return null;
  for (const node of nodes) {
    if (node.path === path) return node;
    if (path.startsWith(`${node.path}/`)) return findFileTreeNode(node.children, path);
  }
  return null;
}

/** 搜索保留匹配项及其祖先，匹配目录时显示其全部子项；空查询返回原树。 */
export function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const text = query.trim().toLocaleLowerCase();
  if (text === "") return nodes;
  return nodes.flatMap((node) => {
    if (node.path.toLocaleLowerCase().includes(text)) return [node];
    const children = filterFileTree(node.children, text);
    return children.length === 0 ? [] : [{ ...node, children }];
  });
}

/** 将展开后的树按显示次序排列；搜索时临时展开匹配祖先，不改变原折叠状态。 */
export function visibleFileRows(
  nodes: FileTreeNode[],
  expanded: ReadonlySet<string>,
  searching = false,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  function visit(items: FileTreeNode[], depth: number, parent: string | null): void {
    items.forEach((node, index) => {
      rows.push({ node, depth, parent, position: index + 1, siblings: items.length });
      if (searching || expanded.has(node.path)) visit(node.children, depth + 1, node.path);
    });
  }
  visit(nodes, 0, null);
  return rows;
}

/** 校验单个文件名；返回用户可读错误，合法时返回 null。 */
export function entryNameError(name: string): string | null {
  if (!name.trim()) return "名称不能为空";
  if (name.startsWith(".") || name.endsWith(".") || name !== name.trim())
    return "名称不能以点开头，或以空格、点结尾";
  if (
    /[\\/:*?"<>|]/.test(name) ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return "名称不能包含路径分隔符或特殊控制字符";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    return "此名称被系统保留，请换一个名称";
  return null;
}

/**
 * 为新笔记或文件夹建议当前目录内可用的名称；同名时从 2 开始递增。
 * @param entries 当前库快照，草稿所需的父目录也视为已占用。
 * @param parent 库内父目录，根目录为空字符串。
 * @param kind 新建条目类型；笔记自动带上 Markdown 扩展名。
 * @returns 可直接编辑的建议名称；最终是否可创建仍由内核独占写入检查。
 */
export function suggestEntryName(
  entries: VaultEntry[],
  parent: string,
  kind: VaultEntry["kind"],
): string {
  const occupied = new Set(
    entries.flatMap((entry) => [entry.path, ...ancestorDirectories(entry.path)]),
  );
  const stem = kind === "file" ? "未命名" : "新建文件夹";
  const extension = kind === "file" ? ".md" : "";
  let name = `${stem}${extension}`;
  let number = 1;
  while (occupied.has(parent === "" ? name : `${parent}/${name}`)) {
    name = `${stem} ${++number}${extension}`;
  }
  return name;
}
