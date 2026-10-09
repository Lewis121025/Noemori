/** @vitest-environment jsdom */
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import FileTreeViewport from "@reader/renderer/library/FileTreeViewport.svelte";
import type { WorkspaceTreeRow } from "@reader/renderer/library/workspace-tree";
import type { FileTreePosition } from "@reader/shared/file-browser";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(count: number) {
  let resize = () => {};
  let width = 460;
  let viewportHeight = 296;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
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
  const rows = writable<WorkspaceTreeRow[]>(
    Array.from({ length: count }, (_, index) => ({
      key: `${index}.md`, title: `${index}.md`, kind: "file", file: null, conversation: null, children: [],
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
      children: createRawSnippet<[WorkspaceTreeRow]>((row) => ({
        render: () => `<button data-path="${row().key}" title="${row().title}"><span class="name">${row().title}</span></button>`,
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
    resize: (value: number, height = viewportHeight) => {
      width = value;
      viewportHeight = height;
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
    const top = 5000 * 30;
    expect(test.grid.scrollTop).toBeLessThanOrEqual(top);
    expect(test.grid.scrollTop + 296).toBeGreaterThanOrEqual(top + 30);
    const path = test.anchor.current!.path;
    test.resize(604);
    expect(test.grid.getAttribute("aria-colcount")).toBe("1");
    expect(test.grid.scrollTop).toBe(Number.parseInt(path) * 30 + test.anchor.current!.offset);
  } finally {
    await test.close();
  }
  expect(test.disconnect).toHaveBeenCalledOnce();
});

it("外部删除焦点条目后交给相邻项，空网格回交搜索入口", async () => {
  const test = start(5);
  try {
    await test.view.focusPath("2.md");
    test.rows.update((rows) => rows.filter((row) => row.key !== "2.md"));
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

it("键盘聚焦被截断名称时显示完整路径，Esc 和尺寸变化收起提示", async () => {
  const test = start(1);
  const show = vi.spyOn(HTMLElement.prototype, "showPopover");
  const hide = vi.spyOn(HTMLElement.prototype, "hidePopover");
  try {
    const button = test.target.querySelector<HTMLButtonElement>("button[data-path]")!;
    button.title = "资料/名称很长而且在窄侧栏中会被截断的笔记.md";
    const name = button.querySelector(".name")!;
    Object.defineProperties(name, { clientWidth: { value: 40 }, scrollWidth: { value: 240 } });
    test.grid.addEventListener("focusin", () => console.log({ path: button.dataset.path, title: button.title, visible: button.matches(":focus-visible"), width: name.clientWidth, scroll: name.scrollWidth }));
    await test.view.focusPath("0.md");
    flushSync();
    const label = test.target.querySelector('[role="tooltip"]')!;
    console.log({ label: label.textContent, active: document.activeElement?.outerHTML, show: show.mock.calls.length });
    expect(show).toHaveBeenCalledOnce();
    expect(label.textContent?.trim()).toBe(button.title);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(label.textContent?.trim()).toBe("");
    expect(hide).toHaveBeenCalled();
    button.blur();
    button.focus();
    flushSync();
    expect(label.textContent?.trim()).toBe(button.title);
    test.resize(192);
    expect(label.textContent?.trim()).toBe("");
  } finally {
    await test.close();
  }
});


it("窗口高度变化不回放尚未交付滚动事件前的旧位置", async () => {
  const test = start(100);
  try {
    test.grid.scrollTop = 150.5;
    test.resize(460, 196);
    expect(test.grid.scrollTop).toBe(150.5);
    expect(test.anchor.current).toEqual({ path: "5.md", offset: 0.5 });
  } finally { await test.close(); }
});
