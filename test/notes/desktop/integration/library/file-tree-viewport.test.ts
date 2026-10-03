/** @vitest-environment jsdom */
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import FileTreeViewport from "@reader/renderer/library/FileTreeViewport.svelte";
import type { FileTreeRow } from "@reader/renderer/library/file-tree";

it("小数行高与整数滚动偏移组合时，挂载后按真实按钮边界保证焦点完整可见", async () => {
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const target = document.createElement("div");
  document.body.append(target);
  const rows: FileTreeRow[] = Array.from({ length: 4 }, (_, index) => ({
    node: { path: `${index}.md`, name: `${index}.md`, kind: "file", children: [] },
    depth: 0,
    parent: null,
    position: index + 1,
    siblings: 4,
  }));
  const view = mount(FileTreeViewport, {
    target,
    props: {
      rows,
      focusable: "3.md",
      dragging: null,
      position: null,
      onPosition: () => {},
      onEmptyFocus: () => {},
      children: createRawSnippet<[FileTreeRow]>((row) => ({
        render: () => `<button data-path="${row().node.path}">${row().node.name}</button>`,
      })),
    },
  });
  flushSync();
  try {
    const viewport = target.querySelector("ul");
    const measure = target.querySelector("li.measure");
    if (!viewport || !measure || !resize) throw new Error("缺少目录测量入口");
    let scroll = 0;
    Object.defineProperty(viewport, "clientHeight", { value: 35 });
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scroll,
      set: (value: number) => {
        scroll = Math.round(value);
      },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 35.1953125));
    const notifyResize = resize;
    const observer = new ResizeObserver(() => {});
    notifyResize(
      [
        {
          target: measure,
          borderBoxSize: [{ blockSize: 35.1875, inlineSize: 0 }],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
          contentRect: new DOMRect(0, 0, 0, 35.1875),
        },
      ],
      observer,
    );
    flushSync();
    const button = target.querySelector<HTMLButtonElement>('[data-path="3.md"]');
    if (!button) throw new Error("缺少焦点按钮");
    vi.spyOn(button, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 3 * 35.1875 - scroll, 200, 33.59375),
    );
    await view.focusPath("3.md");
    expect(document.activeElement).toBe(button);
    expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
  } finally {
    await unmount(view);
    target.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

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
