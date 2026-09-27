import { describe, expect, it } from "vitest";
import type { GraphNode, VaultGraph } from "@reader/shared/api";
import {
  filterGraph,
  graphEquals,
  localGraph,
  neighborMap,
} from "@reader/renderer/engine/graph/model";

const node = (
  path: string,
  tags: string[] = [],
  title = path.replace(/\.md$/u, ""),
): GraphNode => ({
  path,
  title,
  tags,
  dead: false,
});
const edge = (from: string, to: string) => ({ from, to, count: 1 });

// a → b → c → d，e 指向 a，f 孤立。
const graph: VaultGraph = {
  nodes: [
    node("a.md", ["项目"]),
    node("b.md", ["项目/nous"]),
    node("c.md"),
    node("d.md", [], "终点"),
    node("e.md"),
    node("f.md"),
  ],
  edges: [edge("a.md", "b.md"), edge("b.md", "c.md"), edge("c.md", "d.md"), edge("e.md", "a.md")],
};
const paths = (subgraph: VaultGraph) => subgraph.nodes.map((item) => item.path);

describe("neighborMap", () => {
  it("入链与出链都算邻居，孤立节点有空条目", () => {
    const map = neighborMap(graph);
    expect([...map.get("a.md")!].sort()).toEqual(["b.md", "e.md"]);
    expect(map.get("f.md")?.size).toBe(0);
  });
});

describe("graphEquals", () => {
  it("结构相同的重读结果判等；标题、标签、边计数任一变化都不等", () => {
    const copy = structuredClone(graph);
    expect(graphEquals(graph, copy)).toBe(true);
    copy.nodes[0]!.tags = ["别的"];
    expect(graphEquals(graph, copy)).toBe(false);
    const counted = structuredClone(graph);
    counted.edges[0]!.count = 2;
    expect(graphEquals(graph, counted)).toBe(false);
  });
});

describe("localGraph", () => {
  it("按无向边逐层扩展到指定深度，边只保留子图内部的", () => {
    expect(paths(localGraph(graph, "b.md", 1))).toEqual(["a.md", "b.md", "c.md"]);
    expect(paths(localGraph(graph, "b.md", 2))).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(localGraph(graph, "b.md", 1).edges).toEqual([
      edge("a.md", "b.md"),
      edge("b.md", "c.md"),
    ]);
  });

  it("孤立中心只有自己；中心不在图里时为空图", () => {
    expect(paths(localGraph(graph, "f.md", 3))).toEqual(["f.md"]);
    expect(localGraph(graph, "none.md", 2)).toEqual({ nodes: [], edges: [] });
  });
});

describe("filterGraph", () => {
  it("按标题或路径包含匹配，大小写不敏感；边两端都留下才保留", () => {
    const filtered = filterGraph(graph, { query: "终点", showOrphans: true });
    expect(paths(filtered)).toEqual(["d.md"]);
    expect(filtered.edges).toEqual([]);
    expect(paths(filterGraph(graph, { query: "B.MD", showOrphans: true }))).toEqual(["b.md"]);
  });

  it("tag: 前缀按标签匹配并包含子标签，# 可省略", () => {
    expect(paths(filterGraph(graph, { query: "tag:#项目", showOrphans: true }))).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(paths(filterGraph(graph, { query: "tag:项目/nous", showOrphans: true }))).toEqual([
      "b.md",
    ]);
  });

  it("关闭孤立节点时按完整图判定孤立，保留节点不受条件影响", () => {
    expect(paths(filterGraph(graph, { query: "", showOrphans: false }))).not.toContain("f.md");
    // d 的邻居 c 被过滤掉，d 仍不算孤立。
    expect(paths(filterGraph(graph, { query: "终点", showOrphans: false }))).toEqual(["d.md"]);
    expect(paths(filterGraph(graph, { query: "终点", showOrphans: false }, "f.md"))).toEqual([
      "d.md",
      "f.md",
    ]);
  });
});
