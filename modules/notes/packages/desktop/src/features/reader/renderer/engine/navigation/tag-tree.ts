/**
 * 标签树：嵌套标签按 `/` 组树，计数向祖先汇总。
 *
 * 输入是内核的标签升序清单，输出保持同序（兄弟节点按标签字典序）。
 * 纯函数，供标签面板渲染与测试。
 */

import type { TagCount } from "../../../shared/api";

/** 标签树节点。 */
export type TagNode = {
  /** 本段显示名。 */
  name: string;
  /** 完整标签路径（各段以 `/` 连接），检索谓词用它。 */
  path: string;
  /** 本段自身（恰好等于该标签）的文件数。 */
  own: number;
  /** 自身与全部后代的文件数合计。 */
  count: number;
  /** 子标签，字典序。 */
  children: TagNode[];
};

/**
 * 把标签计数清单组成树。
 *
 * @param counts 规范化标签与文件数；同标签重复出现时计数累加。
 */
export function buildTagTree(counts: readonly TagCount[]): TagNode[] {
  const root: TagNode[] = [];
  const index = new Map<string, TagNode>();
  for (const { tag, count } of counts) {
    const segments = tag.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    const chain: TagNode[] = [];
    let siblings = root;
    let path = "";
    for (const segment of segments) {
      path = path === "" ? segment : `${path}/${segment}`;
      let node = index.get(path);
      if (node === undefined) {
        node = { name: segment, path, own: 0, count: 0, children: [] };
        index.set(path, node);
        siblings.push(node);
      }
      chain.push(node);
      siblings = node.children;
    }
    // 计数记到叶子，并沿祖先链汇总。
    const leaf = chain[chain.length - 1];
    if (leaf !== undefined) leaf.own += count;
    for (const node of chain) node.count += count;
  }
  return root;
}

/** 深度优先展平可见节点；`expanded` 里的路径展开子级。 */
export function visibleTagRows(
  nodes: readonly TagNode[],
  expanded: ReadonlySet<string>,
): Array<{ node: TagNode; depth: number }> {
  const out: Array<{ node: TagNode; depth: number }> = [];
  const walk = (list: readonly TagNode[], depth: number): void => {
    for (const node of list) {
      out.push({ node, depth });
      if (node.children.length > 0 && expanded.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}
