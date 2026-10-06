import { expect, it } from "vitest";
import { buildFileTree } from "@reader/renderer/library/file-tree";
import { fileGridRows, gridTarget } from "@reader/renderer/library/file-grid";

const tree = buildFileTree([
  { path: "docs", kind: "directory" },
  { path: "empty", kind: "directory" },
  { path: "docs/a.md", kind: "file" },
  { path: "docs/sub", kind: "directory" },
  { path: "docs/sub/a.md", kind: "file" },
  { path: "a.md", kind: "file" },
  { path: "画布.noemoriboard", kind: "file" },
]);

it("网格只展示当前文件夹的直接子项，白板与其他文件共用身份", () => {
  expect(fileGridRows(tree, "", "").map((row) => row.node.path)).toEqual([
    "docs",
    "empty",
    "画布.noemoriboard",
    "a.md",
  ]);
  expect(fileGridRows(tree, "docs", "").map((row) => row.node.path)).toEqual([
    "docs/sub",
    "docs/a.md",
  ]);
  expect(fileGridRows(tree, "empty", "")).toEqual([]);
  expect(fileGridRows(tree, "missing", "")).toEqual([]);
});

it("路径查询跨文件夹保留同名文件，清除查询后回到原文件夹", () => {
  expect(fileGridRows(tree, "docs", "a.md").map((row) => row.node.path)).toEqual([
    "docs/sub/a.md",
    "docs/a.md",
    "a.md",
  ]);
  expect(fileGridRows(tree, "docs", "")).toHaveLength(2);
});

it("上下键按列数移动，末行和左右边界不会越界", () => {
  expect(gridTarget(1, 8, 3, "ArrowDown")).toBe(4);
  expect(gridTarget(4, 8, 3, "ArrowUp")).toBe(1);
  expect(gridTarget(5, 8, 3, "ArrowDown")).toBe(7);
  expect(gridTarget(0, 8, 3, "ArrowLeft")).toBe(0);
  expect(gridTarget(7, 8, 3, "ArrowRight")).toBe(7);
  expect(gridTarget(2, 8, 3, "Home")).toBe(0);
  expect(gridTarget(2, 8, 3, "End")).toBe(7);
  expect(gridTarget(0, 0, 1, "ArrowDown")).toBeNull();
  expect(gridTarget(0, 8, 3, "F2")).toBeNull();
});
