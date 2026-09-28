/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import { search, getSearchState } from "prosemirror-search";
import SearchPanel from "@reader/renderer/editor/search/EditorSearch.svelte";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/markdown/markdown";
import { documentAccess } from "@reader/renderer/editor/read-only";

let view: EditorView;
let panel: ReturnType<typeof mount>;

function mountPanel(target: HTMLElement, onClose = () => {}, readOnly = false): void {
  const state = fromStore(writable(view.state));
  view.setProps({
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      state.current = view.state;
    },
  });
  panel = mount(SearchPanel, {
    target,
    props: {
      view,
      get state() {
        return state.current;
      },
      onClose,
      readOnly,
    },
  });
  flushSync();
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await unmount(panel);
  view.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("跨格式查找并替换正文，保留链接地址和公式；一次撤销恢复全部替换", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("# 目标\n\n目**标** 与 [目标](https://example.com/目标) 及 $目标$\n"),
      plugins: [history(), search()],
    }),
    handleScrollToSelection: () => true,
  });
  const before = serializeMarkdown(view.state.doc);
  mountPanel(controls);
  const inputs = controls.querySelectorAll("input");
  inputs[0]!.value = "目标";
  inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
  controls.querySelector<HTMLButtonElement>('[aria-label="替换选项"]')!.click();
  flushSync();
  inputs[1]!.value = "新词";
  inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(document.activeElement).toBe(inputs[0]);
  expect(getSearchState(view.state)?.query.search).toBe("目标");
  [...controls.querySelectorAll("button")]
    .find((button) => button.textContent === "全部替换")!
    .click();
  const saved = serializeMarkdown(view.state.doc);
  expect(saved).toContain("# 新词");
  expect(saved).toContain("[新词](https://example.com/目标)");
  expect(saved).toContain("$目标$");
  expect(view.state.doc.textContent).not.toContain("目标");
  undo(view.state, view.dispatch);
  expect(serializeMarkdown(view.state.doc)).toBe(before);
});

it("查找默认收起替换；中文组词回车不跳转，任意控件可用 Escape 返回正文", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("目标 目标"), plugins: [search()] }),
    handleScrollToSelection: () => true,
  });
  const onClose = vi.fn();
  mountPanel(controls, onClose);
  const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
  const toggle = controls.querySelector<HTMLButtonElement>('[aria-label="替换选项"]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(controls.querySelector('[hidden] [aria-label="替换为"]')).not.toBeNull();
  input.value = "目标";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const before = view.state.selection;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(view.state.selection.eq(before)).toBe(true);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(view.state.selection.empty).toBe(false);
  toggle.click();
  flushSync();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(controls.querySelector('[hidden] [aria-label="替换为"]')).toBeNull();
  toggle.focus();
  toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(view.hasFocus()).toBe(true);
  expect(view.state.doc.textContent).toBe("目标 目标");
});

it.each(["Escape", "关闭按钮"])("阅读查找同步命中选区以滚动，%s 关闭后焦点回到正文", (close) => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  const scrollToSelection = vi.fn(() => true);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("前文\n\n阅读目标\n"),
      plugins: [documentAccess(true), search()],
    }),
    handleScrollToSelection: scrollToSelection,
  });
  const before = view.state.doc;
  const onClose = vi.fn();
  mountPanel(controls, onClose, true);
  const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
  input.value = "阅读目标";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(scrollToSelection).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(input);
  if (close === "Escape")
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  else controls.querySelector<HTMLButtonElement>('[aria-label="关闭查找"]')!.click();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(view.dom);
  expect(document.getSelection()?.toString()).toBe("阅读目标");
  expect(view.state.doc).toBe(before);
});

it.each([false, true])(
  "查找立即跳转按当前面板高度避让，不依赖布局回调先完成（只读：%s）",
  (readOnly) => {
    const host = document.createElement("div");
    const controls = document.createElement("div");
    document.body.append(controls, host);
    const margins: number[] = [];
    view = new EditorView(host, {
      state: EditorState.create({
        doc: parseMarkdown("前文\n\n目标 目标\n"),
        plugins: [documentAccess(readOnly), search()],
      }),
      handleScrollToSelection(current) {
        const margin = current.props.scrollMargin;
        margins.push(typeof margin === "number" ? margin : (margin?.top ?? 0));
        return true;
      },
    });
    mountPanel(controls, () => {}, readOnly);
    const form = controls.querySelector("form")!;
    let height = 64;
    Object.defineProperty(form, "offsetHeight", { get: () => height });
    const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
    input.value = "目标";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    // ResizeObserver 替身不发通知，覆盖首次出现和替换行改变高度后的首个操作。
    for (const next of [64, 112]) {
      height = next;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(margins.at(-1)).toBeGreaterThanOrEqual(height);
      expect(document.activeElement).toBe(input);
    }
  },
);

it("查找组词期间不跳转、替换或退出，输入法结束键不冒充查找命令", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("目标 目标"), plugins: [search()] }),
    handleScrollToSelection: () => true,
  });
  const onClose = vi.fn();
  mountPanel(controls, onClose);
  const input = controls.querySelector('[aria-label="查找"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("缺少查找输入框");
  input.value = "目标";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const before = view.state;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  for (const button of controls.querySelectorAll("button")) button.click();
  expect(view.state.doc.eq(before.doc)).toBe(true);
  expect(view.state.selection.eq(before.selection)).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  for (const key of ["Enter", "Escape"]) {
    const event = new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(view.state.selection.eq(before.selection)).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(view.state.selection.empty).toBe(false);
});

it.each([false, true])(
  "查找显示总数与当前序号，跨格式和循环导航保持一致（只读：%s）",
  (readOnly) => {
    const host = document.createElement("div");
    const controls = document.createElement("div");
    document.body.append(controls, host);
    view = new EditorView(host, {
      state: EditorState.create({
        doc: parseMarkdown(
          "# 目标\n\n> [目标](https://example.com/目标)\n\n- 目**标** 与 $目标$\n",
        ),
        plugins: [documentAccess(readOnly), search()],
      }),
      handleScrollToSelection: () => true,
    });
    const before = view.state.doc;
    mountPanel(controls, () => {}, readOnly);
    const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
    const status = controls.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("");
    input.value = "目标";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(status.textContent).toBe("共 3 处");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toBe(status);
    for (const current of [1, 2, 3, 1]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flushSync();
      expect(status.textContent).toBe(`第 ${current} 处，共 3 处`);
      expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
        "目标",
      );
      expect(document.activeElement).toBe(input);
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    flushSync();
    expect(status.textContent).toBe("第 3 处，共 3 处");
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to, from)));
    flushSync();
    expect(status.textContent).toBe("第 3 处，共 3 处");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to - 1)));
    flushSync();
    expect(status.textContent).toBe("共 3 处");
    expect(view.state.doc).toBe(before);
  },
);

it("区分大小写、替换、撤销与清空查询后，命中提示和按钮同步更新", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("Nous nous NOUS\n"),
      plugins: [history(), search()],
    }),
    handleScrollToSelection: () => true,
  });
  mountPanel(controls);
  const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
  const status = controls.querySelector('[role="status"]')!;
  const next = controls.querySelector<HTMLButtonElement>('[aria-label="下一处"]')!;
  const previous = controls.querySelector<HTMLButtonElement>('[aria-label="上一处"]')!;
  input.value = "nous";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(status.textContent).toBe("共 3 处");
  controls.querySelector<HTMLButtonElement>('[aria-label="区分大小写"]')!.click();
  flushSync();
  expect(status.textContent).toBe("共 1 处");
  next.click();
  flushSync();
  expect(status.textContent).toBe("第 1 处，共 1 处");
  controls.querySelector<HTMLButtonElement>('[aria-label="替换选项"]')!.click();
  const replacement = controls.querySelector<HTMLInputElement>('[aria-label="替换为"]')!;
  replacement.value = "笔记";
  replacement.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  [...controls.querySelectorAll("button")].find((button) => button.textContent === "替换")!.click();
  flushSync();
  expect(view.state.doc.textContent).toBe("Nous 笔记 NOUS");
  expect(status.textContent).toBe("没有匹配项");
  expect(next.disabled).toBe(true);
  expect(previous.disabled).toBe(true);
  undo(view.state, view.dispatch);
  flushSync();
  expect(status.textContent).toBe("第 1 处，共 1 处");
  expect(next.disabled).toBe(false);
  controls.querySelector<HTMLButtonElement>('[aria-label="区分大小写"]')!.click();
  flushSync();
  expect(status.textContent).toBe("第 2 处，共 3 处");
  [...controls.querySelectorAll("button")]
    .find((button) => button.textContent === "全部替换")!
    .click();
  flushSync();
  expect(status.textContent).toBe("没有匹配项");
  undo(view.state, view.dispatch);
  flushSync();
  expect(status.textContent).toBe("第 2 处，共 3 处");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(status.textContent).toBe("");
  expect(next.disabled).toBe(true);
  expect(previous.disabled).toBe(true);
});

it("重复字符的上一处与下一处使用同一组高亮，反向循环不落到重叠的隐藏命中", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("aaaaa"), plugins: [search()] }),
    handleScrollToSelection: () => true,
  });
  mountPanel(controls);
  const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
  input.value = "aa";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const next = controls.querySelector<HTMLButtonElement>('[aria-label="下一处"]')!;
  const previous = controls.querySelector<HTMLButtonElement>('[aria-label="上一处"]')!;
  next.click();
  expect(view.state.selection.from).toBe(1);
  next.click();
  expect(view.state.selection.from).toBe(3);
  previous.click();
  expect(view.state.selection.from).toBe(1);
  previous.click();
  expect(view.state.selection.from).toBe(3);
  expect(
    controls.parentElement?.querySelector(".ProseMirror-active-search-match")?.textContent,
  ).toBe("aa");
});
