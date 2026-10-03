/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MarkdownEditorApi } from "@reader/renderer/editor/editor-api";
import Harness from "./ReadOnlyHarness.svelte";

let component: ReturnType<typeof mount> & {
  setReadOnly: (value: boolean) => void;
  setReading: (value: boolean) => void;
  reloadIdentity: () => void;
};
let target: HTMLDivElement;
const registered: { api: MarkdownEditorApi | null } = { api: null };
const dirty = vi.fn();

beforeEach(() => {
  HTMLElement.prototype.hidePopover = vi.fn();
  // jsdom 不排版；实际选区与滚动由桌面端到端测试覆盖。
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  target = document.createElement("div");
  document.body.append(target);
  component = mount(Harness, {
    target,
    props: {
      register: (api) => {
        registered.api = api;
      },
      onDirty: dirty,
    },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

function api(): MarkdownEditorApi {
  if (registered.api === null) throw new Error("编辑器未注册");
  return registered.api;
}

function source(): string {
  return new TextDecoder().decode(api().snapshot().bytes);
}

it("阅读状态保留查找，但不提供替换；任务不可勾选且不触发保存", () => {
  component.setReadOnly(true);
  flushSync();
  const before = source();
  api().openSearch();
  flushSync();
  expect(target.querySelector('[aria-label="查找"]')).not.toBeNull();
  expect(target.querySelector('[aria-label="替换选项"]')).toBeNull();
  expect(target.querySelector('[aria-label="替换为"]')).toBeNull();
  const task = target.querySelector<HTMLButtonElement>(".task-checkbox");
  expect(task?.disabled).toBe(true);
  expect(target.querySelector(".math-inline")?.getAttribute("title")).toBeNull();
  expect(target.querySelector<HTMLInputElement>(".callout-title")?.readOnly).toBe(true);
  task?.click();
  expect(source()).toBe(before);
  expect(dirty).not.toHaveBeenCalled();
});

it.each([false, true])(
  "查找定位展开收起的标注，重复定位仍可展开且不写入正文（只读：%s）",
  (readOnly) => {
    component.setReadOnly(readOnly);
    flushSync();
    const before = source();
    const callout = target.querySelector<HTMLElement>(".callout")!;
    const fold = callout.querySelector<HTMLButtonElement>(".callout-fold")!;
    expect(callout.classList.contains("collapsed")).toBe(true);
    api().openSearch();
    flushSync();
    const input = target.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
    input.value = "标注正文";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(callout.classList.contains("collapsed")).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flushSync();
      expect(callout.classList.contains("collapsed")).toBe(false);
      expect(fold.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(input);
      expect(callout.querySelector(".ProseMirror-active-search-match")?.textContent).toBe(
        "标注正文",
      );
      fold.click();
      expect(callout.classList.contains("collapsed")).toBe(true);
      // 更新查询会重绘高亮，不能把用户刚收起的标注再次展开。
      target.querySelector<HTMLButtonElement>('[aria-label="区分大小写"]')!.click();
      component.setReadOnly(!readOnly);
      flushSync();
      component.setReadOnly(readOnly);
      flushSync();
      expect(callout.classList.contains("collapsed")).toBe(true);
    }
    expect(source()).toBe(before);
    expect(dirty).not.toHaveBeenCalled();
    api().focus();
    expect(api().historyAvailability()).toEqual({ undo: false, redo: false });
  },
);

it.each(
  ["Enter", "Escape", "ArrowDown"].flatMap((key) =>
    [false, true].map((collapsed) => ({ key, collapsed })),
  ),
)(
  "阅读标注标题用 $key 返回正文，焦点与选区一起交接（初始收起：$collapsed）",
  ({ key, collapsed }) => {
    component.setReadOnly(true);
    flushSync();
    if (!collapsed) target.querySelector<HTMLButtonElement>(".callout-fold")!.click();
    const title = target.querySelector<HTMLInputElement>(".callout-title")!;
    const before = source();
    title.focus();
    title.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(target.querySelector(".callout")!.classList.contains("collapsed")).toBe(false);
    expect(document.activeElement).toBe(target.querySelector(".ProseMirror"));
    expect(
      target
        .querySelector(".callout-content")!
        .contains(document.getSelection()?.anchorNode ?? null),
    ).toBe(true);
    expect(source()).toBe(before);
    expect(dirty).not.toHaveBeenCalled();
  },
);

it("阅读状态不能通过历史入口改写正文，恢复编辑后仍可撤销原来的操作", () => {
  const task = target.querySelector<HTMLButtonElement>(".task-checkbox");
  task?.click();
  flushSync();
  expect(source()).toContain("- [x] 任务");
  component.setReadOnly(true);
  flushSync();
  target.querySelector<HTMLElement>(".ProseMirror")?.focus();
  const before = source();
  expect(api().historyAvailability()).toEqual({ undo: false, redo: false });
  api().history("undo");
  expect(source()).toBe(before);
  component.setReadOnly(false);
  flushSync();
  expect(target.querySelector(".math-inline")?.getAttribute("title")).toContain("编辑");
  expect(target.querySelector<HTMLInputElement>(".callout-title")?.readOnly).toBe(false);
  api().history("undo");
  expect(source()).toContain("- [ ] 任务");
});

it("内容未变化的文档代次更新只重新注册表面，保留原 DOM 与重做历史", () => {
  const editor = target.querySelector<HTMLElement>(".ProseMirror");
  target.querySelector<HTMLButtonElement>(".task-checkbox")?.click();
  api().focus();
  api().history("undo");
  expect(api().historyAvailability()?.redo).toBe(true);
  component.reloadIdentity();
  flushSync();
  expect(target.querySelector(".ProseMirror")).toBe(editor);
  expect(api().historyAvailability()?.redo).toBe(true);
  api().history("redo");
  expect(source()).toContain("- [x] 任务");
});

it("阅读模式保留正文、待办和撤销，只隐藏完整编辑工具与源码入口", () => {
  const editor = target.querySelector<HTMLElement>(".ProseMirror")!;
  expect(target.querySelector('[aria-label="编辑工具栏"]')).not.toBeNull();
  component.setReading(true);
  flushSync();
  expect(target.querySelector(".ProseMirror")).toBe(editor);
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(target.querySelector('[aria-label="编辑工具栏"]')).toBeNull();
  expect(target.querySelector(".math-inline")?.getAttribute("title")).toBeNull();
  const task = target.querySelector<HTMLButtonElement>(".task-checkbox")!;
  expect(task.disabled).toBe(false);
  task.click();
  flushSync();
  expect(source()).toContain("- [x] 任务");
  expect(dirty).toHaveBeenCalled();
  api().focus();
  expect(api().historyAvailability()?.undo).toBe(true);
  api().history("undo");
  expect(source()).toContain("- [ ] 任务");
  component.setReading(false);
  flushSync();
  expect(target.querySelector('[aria-label="编辑工具栏"]')).not.toBeNull();
  expect(target.querySelector(".ProseMirror")).toBe(editor);
});
