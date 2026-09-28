/** @vitest-environment jsdom */
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import FileTreeViewport from "@reader/renderer/library/FileTreeViewport.svelte";
import type { FileTreeRow } from "@reader/renderer/library/file-tree";

it("切换搜索或标签卸载目录时，尚未完成的焦点请求取消，不访问旧视口", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const target = document.createElement("div");
  document.body.append(target);
  const view = mount(FileTreeViewport, {
    target,
    props: {
      rows: [
        {
          node: { path: "a.md", name: "a.md", kind: "file", children: [] },
          depth: 0,
          parent: null,
          position: 1,
          siblings: 1,
        },
      ],
      focusable: "a.md",
      dragging: null,
      position: null,
      onPosition: () => {},
      onEmptyFocus: () => {},
      children: createRawSnippet<[FileTreeRow]>(() => ({
        render: () => '<button data-path="a.md">a.md</button>',
      })),
    },
  });
  flushSync();
  try {
    const focus = view.focusPath("a.md");
    const removing = unmount(view);
    await expect(focus).resolves.toBeUndefined();
    await removing;
    expect(document.activeElement).toBe(document.body);
  } finally {
    target.remove();
    vi.unstubAllGlobals();
  }
});
