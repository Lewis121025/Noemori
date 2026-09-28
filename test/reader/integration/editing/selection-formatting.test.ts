/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { writable, type Writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { writingCommands } from "@reader/renderer/engine/editing/writing";
import Harness from "./SelectionFormattingHarness.svelte";

const views: EditorView[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let app: ReturnType<typeof mount>;
let currentView: Writable<EditorView>;
let mounted = false;
let toolbar: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(async () => {
  if (mounted) await unmount(app);
  mounted = false;
  for (const view of views) view.destroy();
  views.length = 0;
  frames.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function layout(): void {
  flushSync();
  const pending = Array.from(frames.values());
  frames.clear();
  for (const callback of pending) callback(0);
}

function createView(source = "选择正文内容"): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const doc = parseMarkdown(source);
  const view = new EditorView(host, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) }),
    handleScrollToSelection: () => true,
  });
  views.push(view);
  // jsdom 不提供文字布局；只固定测量结果，选区与焦点仍使用真实编辑器。
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => ({
    left: 100 + pos * 8,
    right: 100 + pos * 8,
    top: 100,
    bottom: 124,
  }));
  view.focus();
  return view;
}

function openToolbar(source?: string): EditorView {
  const view = createView(source);
  const target = document.createElement("div");
  document.body.append(target);
  currentView = writable(view);
  app = mount(Harness, { target, props: { view: currentView } });
  mounted = true;
  flushSync();
  toolbar = target.querySelector<HTMLDivElement>('[role="toolbar"]')!;
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40));
  layout();
  expect(toolbar.hidden).toBe(false);
  return view;
}

it("替换编辑器后，拖选只由新实例控制，旧实例不再影响工具条", () => {
  const previous = openToolbar();
  previous.dom.dispatchEvent(new Event("pointerdown"));
  expect(toolbar.hidden).toBe(true);
  window.dispatchEvent(new Event("pointerup"));
  layout();
  expect(toolbar.hidden).toBe(false);

  const next = createView();
  currentView.set(next);
  layout();
  expect(toolbar.hidden).toBe(false);
  next.dom.dispatchEvent(new Event("pointerdown"));
  expect(toolbar.hidden).toBe(true);
  window.dispatchEvent(new Event("pointerup"));
  layout();
  expect(toolbar.hidden).toBe(false);
  previous.dom.dispatchEvent(new Event("pointerdown"));
  expect(toolbar.hidden).toBe(false);
});

it.each(["拖选中", "Escape 关闭后"])("%s替换编辑器，不继承旧文档的临时交互状态", (phase) => {
  const previous = openToolbar();
  previous.dom.dispatchEvent(
    phase === "拖选中"
      ? new Event("pointerdown")
      : new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(toolbar.hidden).toBe(true);

  currentView.set(createView());
  layout();
  expect(toolbar.hidden).toBe(false);
});

it("卸载时取消待执行布局，移除旧编辑器和全局事件监听", async () => {
  const previous = openToolbar();
  currentView.set(createView());
  flushSync();
  expect(frames.size).toBeGreaterThan(0);
  await unmount(app);
  mounted = false;
  expect(frames.size).toBe(0);

  toolbar.hidden = false;
  for (const view of views) view.dom.dispatchEvent(new Event("pointerdown"));
  expect(toolbar.hidden).toBe(false);
  for (const type of ["pointerup", "pointercancel", "scroll", "resize"])
    window.dispatchEvent(new Event(type));
  for (const type of ["focusin", "focusout"]) document.dispatchEvent(new Event(type));
  previous.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(toolbar.hidden).toBe(false);
  expect(frames.size).toBe(0);
});

it("连续滚动只更新位置，不重复计算未变化选区的格式能力", () => {
  const view = openToolbar();
  const check = vi.spyOn(writingCommands, "bold");
  const measure = vi.mocked(view.coordsAtPos);
  measure.mockClear();
  for (let frame = 0; frame < 20; frame++) {
    for (let event = 0; event < 10; event++) window.dispatchEvent(new Event("scroll"));
    layout();
  }
  expect(measure).toHaveBeenCalledTimes(40);
  expect(check.mock.calls.length).toBe(0);
  expect(toolbar.hidden).toBe(false);
});

it("混合格式显示部分选中，点击后统一格式且选区与焦点保持在正文", () => {
  const view = openToolbar("**选**择正");
  const bold = toolbar.querySelector<HTMLButtonElement>('[aria-label="加粗"]')!;
  expect(bold.getAttribute("aria-pressed")).toBe("mixed");
  const selection = view.state.selection;
  bold.click();
  currentView.set(view);
  layout();
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(view.state.doc.firstChild?.firstChild?.text).toBe("选择正");
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(view.hasFocus()).toBe(true);
});
