import { describe, expect, it } from "vitest";
import {
  ancestorDirectories,
  buildFileTree,
  entryNameError,
  filterFileTree,
  suggestEntryName,
  visibleFileRows,
} from "@reader/renderer/engine/navigation/file-tree";
import type { VaultEntry } from "@reader/shared/api";

const entries: VaultEntry[] = [
  { path: "笔记10.md", kind: "file" },
  { path: "项目/同名.md", kind: "file" },
  { path: "笔记2.md", kind: "file" },
  { path: "归档/同名.md", kind: "file" },
  { path: "空文件夹", kind: "directory" },
  { path: "项目/深层/内容.md", kind: "file" },
];

describe("文件树数据契约", () => {
  it("目录优先、数字自然排序，同名文件使用完整路径区分", () => {
    const tree = buildFileTree(entries);
    expect(tree.slice(-2).map((node) => node.name)).toEqual(["笔记2.md", "笔记10.md"]);
    const all = visibleFileRows(tree, new Set(), true);
    expect(
      all
        .filter((row) => row.node.name === "同名.md")
        .map((row) => row.node.path)
        .sort(),
    ).toEqual(["归档/同名.md", "项目/同名.md"]);
    expect(all.find((row) => row.node.path === "项目/深层/内容.md")).toMatchObject({
      depth: 2,
      parent: "项目/深层",
    });
    expect(tree.find((node) => node.path === "空文件夹")).toMatchObject({
      kind: "directory",
      children: [],
    });
  });
  it("折叠目录时不渲染子项，当前文件的所有祖先可一次展开", () => {
    const tree = buildFileTree(entries);
    expect(visibleFileRows(tree, new Set()).some((row) => row.node.path.endsWith("同名.md"))).toBe(
      false,
    );
    const expanded = new Set(ancestorDirectories("项目/深层/内容.md"));
    expect(visibleFileRows(tree, expanded).map((row) => row.node.path)).toContain(
      "项目/深层/内容.md",
    );
    expect(ancestorDirectories("顶层.md")).toEqual([]);
  });
  it("搜索保留父级路径和匹配目录的后代，不改变折叠集合", () => {
    const tree = buildFileTree(entries);
    const folded = new Set<string>();
    expect(
      visibleFileRows(filterFileTree(tree, "内容"), folded, true).map((row) => row.node.path),
    ).toEqual(["项目", "项目/深层", "项目/深层/内容.md"]);
    expect(
      visibleFileRows(filterFileTree(tree, "项目"), folded, true).map((row) => row.node.path),
    ).toContain("项目/同名.md");
    expect(filterFileTree(tree, "不存在")).toEqual([]);
    expect(folded.size).toBe(0);
  });
  it("草稿目录和显式目录合并，不产生重复节点", () => {
    const tree = buildFileTree([
      { path: "恢复/内容.md", kind: "file" },
      { path: "恢复", kind: "directory" },
      { path: "恢复/内容.md", kind: "file" },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
  });
  it("文件名支持中文与空格，拒绝路径穿越、不可见名称和系统保留名称", () => {
    expect(entryNameError("我的 笔记.md")).toBeNull();
    for (const name of [
      "",
      ".",
      "..",
      "../外部",
      "a/b",
      "a\\b",
      ".隐藏",
      "CON.md",
      "尾部.",
      "尾部 ",
      "a\u0000b",
    ])
      expect(entryNameError(name), name).not.toBeNull();
  });
  it("新建名称避开同目录已有条目，并保留其他目录的可用名称", () => {
    const files: VaultEntry[] = [
      { path: "未命名.md", kind: "file" },
      { path: "未命名 2.md", kind: "directory" },
      { path: "未命名 4.md", kind: "file" },
      { path: "项目/新建文件夹", kind: "directory" },
    ];
    expect(suggestEntryName(files, "", "file")).toBe("未命名 3.md");
    expect(suggestEntryName(files, "项目", "file")).toBe("未命名.md");
    expect(suggestEntryName(files, "项目", "directory")).toBe("新建文件夹 2");
    expect(suggestEntryName(files, "", "directory")).toBe("新建文件夹");
  });
  it("建议名称不会占用恢复草稿缺失的父目录", () => {
    expect(suggestEntryName([{ path: "未命名.md/恢复.md", kind: "file" }], "", "file")).toBe(
      "未命名 2.md",
    );
  });
});
