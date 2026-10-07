/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { ReaderFileTree } from "@reader/renderer/library/state.svelte";

it("搜索退出恢复文件、目录和滚动锚点，期间改名跟随新路径", () => {
  const tree = new ReaderFileTree(() => "/notes", vi.fn(), vi.fn());
  const original = {
    browse: { query: "", section: "files" as const, directory: "光学" },
    expanded: ["光学"],
    selected: ["光学/原理.md"],
    focused: "光学/原理.md",
    scroll: { path: "光学/原理.md", offset: 5 },
  };
  tree.restore(original, [{ path: "光学/原理.md", kind: "file" }]);
  tree.setQuery("不存在的词");
  tree.update({ selected: [], focused: null });
  tree.remap((path) => (path === "光学/原理.md" ? "光学/原理二.md" : path));
  tree.setQuery("");
  expect(tree.state).toMatchObject({
    ...original,
    selected: ["光学/原理二.md"],
    focused: "光学/原理二.md",
    scroll: { path: "光学/原理二.md", offset: 5 },
  });
  tree.reset();
});

it("切库和搜索期间删除文件不会恢复失效选择", () => {
  const tree = new ReaderFileTree(() => "/notes", vi.fn(), vi.fn());
  tree.restore({ expanded: [], selected: ["a.md"], focused: "a.md", scroll: null }, [
    { path: "a.md", kind: "file" },
  ]);
  tree.setQuery("不存在");
  tree.reconcile([]);
  tree.setQuery("");
  expect(tree.state.selected).toEqual([]);
  expect(tree.state.focused).toBeNull();
  tree.reset();
  tree.restore(null, []);
  tree.setQuery("");
  expect(tree.state.selected).toEqual([]);
  tree.reset();
});

it("清空搜索只恢复浏览现场，不撤销搜索期间主动更改的排序", () => {
  const tree = new ReaderFileTree(() => "/notes", vi.fn(), vi.fn());
  tree.restore(
    {
      expanded: [],
      selected: ["a.md"],
      focused: "a.md",
      scroll: null,
      presentation: { layout: "list", sort: "name", preview: true },
    },
    [{ path: "a.md", kind: "file" }],
  );
  tree.setQuery("a");
  tree.update({ presentation: { layout: "list", sort: "modified", preview: true } });
  tree.setQuery("");
  expect(tree.state.presentation?.sort).toBe("modified");
  expect(tree.state.selected).toEqual(["a.md"]);
  tree.reset();
});
