import { describe, expect, it } from "vitest";
import type { Bookmark } from "@reader/shared/api";
import {
  bookmarkLabel,
  bookmarkMissing,
  moveBookmark,
  sameBookmark,
  toggleBookmark,
} from "@reader/renderer/engine/navigation/bookmarks";

const file = (path: string, title: string | null = null): Bookmark => ({
  kind: "file",
  path,
  title,
});

describe("sameBookmark", () => {
  it("按种类与目标判等，显示名不参与；标题按锚点规则归一", () => {
    expect(sameBookmark(file("a.md", "甲"), file("a.md"))).toBe(true);
    expect(sameBookmark(file("a.md"), { kind: "folder", path: "a.md", title: null })).toBe(false);
    expect(
      sameBookmark(
        { kind: "heading", path: "a.md", heading: "设计  笔记", title: null },
        { kind: "heading", path: "a.md", heading: "设计 笔记", title: null },
      ),
    ).toBe(true);
    expect(
      sameBookmark(
        { kind: "search", query: "tag:#x", title: null },
        { kind: "search", query: "tag:#y", title: null },
      ),
    ).toBe(false);
  });
});

describe("toggleBookmark / moveBookmark", () => {
  it("已有目标移除，否则追加到末尾；原数组不变", () => {
    const list = [file("a.md"), file("b.md")];
    expect(toggleBookmark(list, file("c.md"))).toEqual([...list, file("c.md")]);
    expect(toggleBookmark(list, file("a.md", "别名"))).toEqual([file("b.md")]);
    expect(list).toHaveLength(2);
  });

  it("拖动重排：插入到目标位置之前，越界收敛，原位不产生新数组", () => {
    const list = [file("a.md"), file("b.md"), file("c.md")];
    expect(moveBookmark(list, 0, 2).map((item) => item.kind === "file" && item.path)).toEqual([
      "b.md",
      "a.md",
      "c.md",
    ]);
    expect(moveBookmark(list, 2, 0).map((item) => item.kind === "file" && item.path)).toEqual([
      "c.md",
      "a.md",
      "b.md",
    ]);
    expect(moveBookmark(list, 0, 99).map((item) => item.kind === "file" && item.path)).toEqual([
      "b.md",
      "c.md",
      "a.md",
    ]);
    expect(moveBookmark(list, 1, 1)).toBe(list);
    expect(moveBookmark(list, 5, 0)).toBe(list);
  });
});

describe("bookmarkLabel", () => {
  it("自定义名优先；文件去 .md 扩展名，标题带所在笔记", () => {
    expect(bookmarkLabel(file("docs/设计.md", "入口"))).toBe("入口");
    expect(bookmarkLabel(file("docs/设计.md"))).toBe("设计");
    expect(bookmarkLabel(file("img/图.png"))).toBe("图.png");
    expect(bookmarkLabel({ kind: "folder", path: "docs/归档", title: null })).toBe("归档");
    expect(
      bookmarkLabel({ kind: "heading", path: "docs/设计.md", heading: "目标", title: null }),
    ).toBe("设计 › 目标");
    expect(bookmarkLabel({ kind: "search", query: "tag:#x", title: null })).toBe("tag:#x");
  });
});

describe("bookmarkMissing", () => {
  const entries = [
    { path: "docs", kind: "directory" as const, recoveryOnly: false },
    { path: "docs/a.md", kind: "file" as const, recoveryOnly: false },
    { path: "lost.md", kind: "file" as const, recoveryOnly: true },
  ];
  it("文件与标题要求文件存在，文件夹要求目录存在；只剩草稿的路径视为失效", () => {
    expect(bookmarkMissing(file("docs/a.md"), entries)).toBe(false);
    expect(bookmarkMissing(file("docs"), entries)).toBe(true);
    expect(bookmarkMissing(file("lost.md"), entries)).toBe(true);
    expect(bookmarkMissing({ kind: "folder", path: "docs", title: null }, entries)).toBe(false);
    expect(
      bookmarkMissing({ kind: "heading", path: "gone.md", heading: "x", title: null }, entries),
    ).toBe(true);
    expect(bookmarkMissing({ kind: "search", query: "x", title: null }, entries)).toBe(false);
  });
});
