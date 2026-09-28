/**
 * 图谱的纯数据操作：邻接、局部子图与过滤。
 *
 * 链接是有向的，但阅读关系是双向的：局部图谱与悬停高亮都按无向邻接计算，
 * 入链与出链同样算作邻居。
 */

import type { GraphNode, VaultGraph } from "../../shared/api";

/** 图谱过滤条件。 */
export type GraphFilter = {
  /** 过滤文本；`tag:` 前缀按标签匹配（含子标签），否则按标题或路径包含匹配。 */
  readonly query: string;
  /** 是否显示没有任何链接的笔记。 */
  readonly showOrphans: boolean;
};

/** 无向邻接表；每个节点都有条目，孤立节点为空集合。 */
export function neighborMap(graph: VaultGraph): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>(graph.nodes.map((node) => [node.path, new Set()]));
  for (const edge of graph.edges) {
    map.get(edge.from)?.add(edge.to);
    map.get(edge.to)?.add(edge.from);
  }
  return map;
}

/** 两张图的节点与边逐项相等；库变更后索引重读的结果未变时据此跳过重新布局。 */
export function graphEquals(a: VaultGraph, b: VaultGraph): boolean {
  return (
    a.nodes.length === b.nodes.length &&
    a.edges.length === b.edges.length &&
    a.nodes.every((node, index) => {
      const other = b.nodes[index]!;
      return (
        node.path === other.path &&
        node.title === other.title &&
        node.dead === other.dead &&
        node.tags.length === other.tags.length &&
        node.tags.every((tag, at) => tag === other.tags[at])
      );
    }) &&
    a.edges.every((edge, index) => {
      const other = b.edges[index]!;
      return edge.from === other.from && edge.to === other.to && edge.count === other.count;
    })
  );
}

function subgraph(graph: VaultGraph, keep: ReadonlySet<string>): VaultGraph {
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.path)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

/**
 * 以 `center` 为中心、沿无向边走 `depth` 步内可达的子图。
 *
 * @returns 中心不在图里时为空图。
 */
export function localGraph(graph: VaultGraph, center: string, depth: number): VaultGraph {
  const neighbors = neighborMap(graph);
  if (!neighbors.has(center)) return { nodes: [], edges: [] };
  const reached = new Set([center]);
  let frontier = [center];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const neighbor of neighbors.get(path) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return subgraph(graph, reached);
}

function matches(node: GraphNode, query: string): boolean {
  if (query.startsWith("tag:")) {
    const tag = query.slice(4).replace(/^#/u, "");
    if (tag === "") return true;
    return node.tags.some((own) => {
      const lower = own.toLowerCase();
      return lower === tag || lower.startsWith(`${tag}/`);
    });
  }
  return node.title.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
}

/**
 * 按条件过滤节点，边只保留两端都留下的。
 *
 * 孤立与否按过滤前的完整图判定：过滤掉邻居不会让一篇有链接的笔记变成「孤立」。
 * @param keep 无论条件如何都保留的节点（局部图谱的中心）。
 */
export function filterGraph(
  graph: VaultGraph,
  filter: GraphFilter,
  keep: string | null = null,
): VaultGraph {
  const query = filter.query.trim().toLowerCase();
  const neighbors = filter.showOrphans ? null : neighborMap(graph);
  const kept = new Set<string>();
  for (const node of graph.nodes) {
    if (node.path === keep) kept.add(node.path);
    else if (neighbors !== null && (neighbors.get(node.path)?.size ?? 0) === 0) continue;
    else if (query === "" || matches(node, query)) kept.add(node.path);
  }
  return subgraph(graph, kept);
}
