import { describe, expect, it } from "vitest";
import { buildTagTree, visibleTagRows } from "@reader/renderer/engine/navigation/tag-tree";

describe("buildTagTree", () => {
  it("按 / 组树，计数向祖先汇总，自身计数单列", () => {
    const tree = buildTagTree([
      { tag: "project", count: 2 },
      { tag: "project/nous", count: 3 },
      { tag: "project/nous/search", count: 1 },
      { tag: "阅读", count: 5 },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ name: "project", path: "project", own: 2, count: 6 });
    expect(tree[0]?.children[0]).toMatchObject({
      name: "nous",
      path: "project/nous",
      own: 3,
      count: 4,
    });
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({
      path: "project/nous/search",
      own: 1,
      count: 1,
      children: [],
    });
    expect(tree[1]).toMatchObject({ name: "阅读", own: 5, count: 5, children: [] });
  });

  it("没有自身计数的中间段只汇总后代", () => {
    const tree = buildTagTree([{ tag: "a/b/c", count: 1 }]);
    expect(tree[0]).toMatchObject({ name: "a", own: 0, count: 1 });
    expect(tree[0]?.children[0]).toMatchObject({ name: "b", own: 0, count: 1 });
  });

  it("空清单产出空树，畸形标签段被跳过", () => {
    expect(buildTagTree([])).toEqual([]);
    expect(buildTagTree([{ tag: "//", count: 1 }])).toEqual([]);
  });
});

describe("visibleTagRows", () => {
  const tree = buildTagTree([
    { tag: "a", count: 1 },
    { tag: "a/b", count: 2 },
  ]);

  it("未展开只显示顶层，展开后带深度显示子级", () => {
    expect(visibleTagRows(tree, new Set()).map((row) => row.node.path)).toEqual(["a"]);
    expect(visibleTagRows(tree, new Set(["a"])).map((row) => [row.node.path, row.depth])).toEqual([
      ["a", 0],
      ["a/b", 1],
    ]);
  });
});
