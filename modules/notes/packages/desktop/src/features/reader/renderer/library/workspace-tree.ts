import type { VaultEntry } from "../../shared/api";
import type { WorkspaceConversation } from "../../shared/workspace-conversations";
import { buildFileTree, type FileTreeNode } from "./file-tree";
import { libraryTitle } from "./library-tree";

/** 文件与对话使用互不相交的身份；只有 file 字段可交给文件管理接口。 */
export type WorkspaceTreeNode = {
  key: string;
  title: string;
  kind: "file" | "directory" | "conversation" | "source" | "workspace";
  file: FileTreeNode | null;
  conversation: WorkspaceConversation | null;
  children: WorkspaceTreeNode[];
};
/** 扁平可见行与原节点共享身份，祖先信息用于键盘导航及无障碍树层级。 */
export type WorkspaceTreeRow = WorkspaceTreeNode & {
  depth: number;
  parent: string | null;
  position: number;
  siblings: number;
};
const compare = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
/** 合成键包含文件路径不允许的空字符，不会与真实目录、文件重名。 */
export function conversationKey(id: string): string {
  return `\0conversation:${id}`;
}
/**
 * 按实际归属建立统一目录。文章下挂对话，同归属分叉挂在来源下；失效来源保留独立历史节点。
 * @param entries 当前库的真实条目，恢复草稿不参与目录操作。
 * @param conversations 已加载的会话导航投影，包含归档状态及来源关系。
 * @param root 当前库根；未打开库时为 null，无目录关联的对话独立展示。
 * @param archived 是否包含归档会话；活动分叉的归档祖先始终保留。
 * @returns 新树，不修改输入；损坏或循环的分叉关系回退到各自归属，不隐藏记录。
 */
export function buildWorkspaceTree(
  entries: readonly VaultEntry[],
  conversations: readonly WorkspaceConversation[],
  root: string | null,
  archived: boolean,
): WorkspaceTreeNode[] {
  const files = new Map<string, WorkspaceTreeNode>();
  const convert = (file: FileTreeNode): WorkspaceTreeNode => {
    const node: WorkspaceTreeNode = {
      key: file.path,
      title: libraryTitle(file),
      kind: file.kind,
      file,
      conversation: null,
      children: file.children.map(convert),
    };
    files.set(file.path, node);
    return node;
  };
  const roots = buildFileTree(entries.filter((entry) => !entry.recoveryOnly)).map(convert);
  const groups = new Map<string, WorkspaceTreeNode>();
  function group(
    key: string,
    title: string,
    kind: "source" | "workspace",
    parent?: WorkspaceTreeNode,
  ): WorkspaceTreeNode {
    let node = groups.get(key);
    if (!node) {
      node = { key, title, kind, file: null, conversation: null, children: [] };
      groups.set(key, node);
      (parent?.children ?? roots).push(node);
    }
    return node;
  }
  function owner(item: WorkspaceConversation): WorkspaceTreeNode | null {
    if (item.workspace === null) return null;
    const article = item.article;
    if (article) {
      const file = item.workspace === root ? files.get(article.path) : undefined;
      if (file?.kind === "file" && !article.removed && article.status !== "article-missing")
        return file;
      const directory =
        item.workspace === root
          ? undefined
          : group(`\0workspace:${item.workspace}`, item.workspace, "workspace");
      return group(
        `\0source:${JSON.stringify([item.workspace, article.removed === true, article.path])}`,
        article.title,
        "source",
        directory,
      );
    }
    if (root && item.workspace === root) return null;
    if (root && item.workspace.startsWith(`${root}/`)) {
      const directory = files.get(item.workspace.slice(root.length + 1));
      if (directory?.kind === "directory") return directory;
    }
    return group(`\0workspace:${item.workspace}`, item.workspace, "workspace");
  }
  const items = new Map(conversations.map((item) => [item.id, item]));
  // 非归档分叉保留归档祖先，避免把来源关系改写成无来源的新对话。
  const retained = new Set(
    conversations.filter((item) => archived || !item.archived).map((item) => item.id),
  );
  for (const id of retained) {
    let next = items.get(id)?.origin?.conversationId;
    const visited = new Set([id]);
    while (next && !visited.has(next) && items.has(next)) {
      visited.add(next);
      retained.add(next);
      next = items.get(next)?.origin?.conversationId;
    }
  }
  const nodes = new Map<string, WorkspaceTreeNode>();
  const owners = new Map<string, WorkspaceTreeNode | null>();
  for (const item of conversations) {
    if (!retained.has(item.id)) continue;
    nodes.set(item.id, {
      key: conversationKey(item.id),
      title: item.title,
      kind: "conversation",
      file: null,
      conversation: item,
      children: [],
    });
    owners.set(item.id, owner(item));
  }
  function validOrigin(item: WorkspaceConversation): WorkspaceTreeNode | undefined {
    const parent = item.origin?.conversationId;
    if (!parent || owners.get(parent) !== owners.get(item.id)) return;
    const seen = new Set([item.id]);
    let next: string | undefined = parent;
    while (next) {
      if (seen.has(next)) return;
      seen.add(next);
      next = items.get(next)?.origin?.conversationId;
    }
    return nodes.get(parent);
  }
  for (const item of conversations) {
    const node = nodes.get(item.id);
    if (!node) continue;
    const parent = validOrigin(item) ?? owners.get(item.id);
    (parent?.children ?? roots).push(node);
  }
  function order(nodes: WorkspaceTreeNode[]): void {
    nodes.sort((a, b) => {
      const rank = (node: WorkspaceTreeNode) =>
        node.kind === "directory"
          ? 0
          : node.kind === "file"
            ? 1
            : node.kind === "conversation"
              ? 2
              : 3;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.conversation && b.conversation)
        return (
          b.conversation.updatedAt - a.conversation.updatedAt || compare.compare(a.title, b.title)
        );
      return compare.compare(a.title, b.title) || compare.compare(a.key, b.key);
    });
    for (const node of nodes) order(node.children);
  }
  order(roots);
  return roots;
}
/**
 * 搜索保留命中祖先并临时展开；不修改原树或浏览展开集合。
 * @param tree 已按真实归属组织的节点。
 * @param expanded 浏览时展开的节点身份。
 * @param query 统一查询原文；空白表示浏览。
 * @param fileMatches 文件名及正文检索命中的真实路径。
 * @param closed 本次搜索中手动折叠的节点。
 * @returns 带层级及同级位置的可见行，不执行 IO 或抛出业务异常。
 */
export function workspaceTreeRows(
  tree: readonly WorkspaceTreeNode[],
  expanded: ReadonlySet<string>,
  query: string,
  fileMatches: ReadonlySet<string>,
  closed: ReadonlySet<string>,
): WorkspaceTreeRow[] {
  const text = query.trim().toLocaleLowerCase();
  const retained = new Set<string>();
  function matches(node: WorkspaceTreeNode): boolean {
    const childMatch = node.children.map(matches).some(Boolean);
    const own = node.file
      ? fileMatches.has(node.file.path)
      : node.title.toLocaleLowerCase().includes(text);
    if (childMatch || own) retained.add(node.key);
    return childMatch || own;
  }
  if (text) tree.forEach(matches);
  const rows: WorkspaceTreeRow[] = [];
  function visit(nodes: readonly WorkspaceTreeNode[], parent: string | null, depth: number): void {
    const visible = text ? nodes.filter((node) => retained.has(node.key)) : nodes;
    visible.forEach((node, index) => {
      rows.push({ ...node, parent, depth, position: index + 1, siblings: visible.length });
      if (text ? !closed.has(node.key) : expanded.has(node.key))
        visit(node.children, node.key, depth + 1);
    });
  }
  visit(tree, null, 0);
  return rows;
}
