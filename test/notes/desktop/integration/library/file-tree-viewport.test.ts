/** @vitest-environment jsdom */
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import FileTreeViewport from "@reader/renderer/library/FileTreeViewport.svelte";
import type { FileTreeRow } from "@reader/renderer/library/file-tree";
import type { FileTreePosition } from "@reader/shared/file-browser";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(count: number) {
  let resize = () => {};
  let width = 460;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(296);
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const rows = writable<FileTreeRow[]>(
    Array.from({ length: count }, (_, index) => ({
      node: { path: `${index}.md`, name: `${index}.md`, kind: "file", children: [] },
      depth: 0,
      parent: null,
      position: index + 1,
      siblings: count,
    })),
  );
  const position = writable<FileTreePosition | null>(null);
  const items = fromStore(rows);
  const anchor = fromStore(position);
  const target = document.createElement("div");
  document.body.append(target);
  const empty = vi.fn();
  const view = mount(FileTreeViewport, {
    target,
    props: {
      get rows() {
        return items.current;
      },
      focused: null,
      dragging: null,
      selected: new Set(),
      expanded: new Set(),
      excerpts: new Set(),
      get position() {
        return anchor.current;
      },
      onPosition: (value) => position.set(value),
      onEmptyFocus: empty,
      children: createRawSnippet<[FileTreeRow]>((row) => ({
        render: () => `<button data-path="${row().node.path}">${row().node.name}</button>`,
      })),
    },
  });
  flushSync();
  const grid = target.querySelector<HTMLDivElement>('[role="treegrid"]')!;
  return {
    target,
    view,
    rows,
    position,
    anchor,
    empty,
    grid,
    disconnect,
    resize: (value: number) => {
      width = value;
      resize();
      flushSync();
    },
    close: async () => {
      await unmount(view);
      target.remove();
    },
  };
}

it("万项层级列表只挂载可见行，远处焦点挂载后可见且缩放保持锚点", async () => {
  const test = start(10000);
  try {
    expect(test.target.querySelectorAll("button").length).toBeLessThan(100);
    await test.view.focusPath("5000.md");
    flushSync();
    expect(document.activeElement?.getAttribute("data-path")).toBe("5000.md");
    const top = 5000 * 28;
    expect(test.grid.scrollTop).toBeLessThanOrEqual(top);
    expect(test.grid.scrollTop + 296).toBeGreaterThanOrEqual(top + 28);
    const path = test.anchor.current!.path;
    test.resize(604);
    expect(test.grid.getAttribute("aria-colcount")).toBe("1");
    expect(test.grid.scrollTop).toBe(Number.parseInt(path) * 28 + test.anchor.current!.offset);
  } finally {
    await test.close();
  }
  expect(test.disconnect).toHaveBeenCalledOnce();
});

it("外部删除焦点条目后交给相邻项，空网格回交搜索入口", async () => {
  const test = start(5);
  try {
    await test.view.focusPath("2.md");
    test.rows.update((rows) => rows.filter((row) => row.node.path !== "2.md"));
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement?.getAttribute("data-path")).toBe("3.md");
    test.rows.set([]);
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.empty).toHaveBeenCalledOnce();
  } finally {
    await test.close();
  }
});

it("卸载取消等待中的焦点交接，浏览器夹取滚动时及时记录实际锚点", async () => {
  const test = start(2);
  let focusing: Promise<void>;
  try {
    Object.defineProperty(test.grid, "scrollTop", { get: () => 0, set: () => {} });
    test.position.set({ path: "1.md", offset: 100 });
    flushSync();
    expect(test.anchor.current).toEqual({ path: "0.md", offset: 0 });
    focusing = test.view.focusPath("1.md");
  } finally {
    await test.close();
  }
  await expect(focusing).resolves.toBeUndefined();
  expect(document.activeElement).toBe(document.body);
});

it("行末的小数像素锚点原样恢复，不能向上取整造成触控板回跳", async () => {
  const test = start(40);
  try {
    test.position.set({ path: "0.md", offset: 27.5 });
    flushSync();
    expect(test.grid.scrollTop).toBe(27.5);
  } finally {
    await test.close();
  }
});
