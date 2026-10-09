/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import {
  createLinkSelectionPlugin,
  linkSelectionKey,
} from "@reader/renderer/editor/links/link-editing";
import { documentAccess, setDocumentReadOnly } from "@reader/renderer/editor/read-only";
import Harness from "./EditorFormattingHarness.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function toolbar() {
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const initial = EditorState.create({
    doc: parseMarkdown("前文\n\n后文"),
    plugins: [history(), createLinkSelectionPlugin(), documentAccess(false)],
  });
  const state = writable(initial);
  const view = new EditorView(host, {
    state: initial,
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      state.set(view.state);
    },
    handleScrollToSelection: () => true,
  });
  const originalShow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value(this: HTMLElement) {
      this.dispatchEvent(
        Object.assign(new Event("beforetoggle"), { newState: "open", oldState: "closed" }),
      );
      this.setAttribute("data-test-open", "true");
    },
  });
  vi.spyOn(HTMLElement.prototype, "hidePopover").mockImplementation(function (this: HTMLElement) {
    this.dispatchEvent(
      Object.assign(new Event("beforetoggle"), { newState: "closed", oldState: "open" }),
    );
    this.removeAttribute("data-test-open");
  });
  const app = mount(Harness, { target, props: { view, state } });
  flushSync();
  cleanups.push(async () => {
    await unmount(app);
    if (!view.isDestroyed) view.destroy();
    host.remove();
    target.remove();
    if (originalShow) Object.defineProperty(HTMLElement.prototype, "showPopover", originalShow);
    else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  });
  const button = (label: string) => {
    const element = target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!element) throw new Error(`缺少按钮：${label}`);
    return element;
  };
  const open = () => {
    button("表格…").click();
    flushSync();
  };
  const input = (label: string, value: string) => {
    const element = target.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!element) throw new Error(`缺少输入框：${label}`);
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  };
  return { view, target, button, open, input };
}

it("尺寸预览和取消不创建表格；确认所选尺寸与对齐后一次撤销恢复原文", () => {
  const tools = toolbar();
  const original = tools.view.state.doc;
  tools.open();
  const cell = tools.target.querySelector<HTMLElement>(
    '[data-table-rows="4"][data-table-columns="5"]',
  );
  expect(cell).not.toBeNull();
  cell?.click();
  tools.button("右对齐").click();
  flushSync();
  expect(tools.view.state.doc.eq(original)).toBe(true);
  tools.button("取消插入表格").click();
  expect(tools.view.state.doc.eq(original)).toBe(true);
  expect(linkSelectionKey.getState(tools.view.state)).toBeNull();
  tools.open();
  tools.button("插入表格").click();
  flushSync();
  const table = tools.view.state.doc.child(1);
  expect(table.childCount).toBe(4);
  expect(table.firstChild?.childCount).toBe(5);
  expect(table.firstChild?.firstChild?.attrs["align"]).toBe("right");
  expect(tools.view.state.selection.$from.parent.type.name).toBe("table_header");
  expect(undo(tools.view.state, tools.view.dispatch)).toBe(true);
  expect(tools.view.state.doc.eq(original)).toBe(true);
  expect(undo(tools.view.state, tools.view.dispatch)).toBe(false);
});

it("精确尺寸拒绝空值和越界，键盘调整后按确认配置创建", () => {
  const tools = toolbar();
  tools.open();
  tools.input("行数（含表头）", "");
  expect(tools.button("插入表格").disabled).toBe(true);
  tools.input("行数（含表头）", "21");
  expect(tools.button("插入表格").disabled).toBe(true);
  tools.input("行数（含表头）", "7");
  tools.input("列数", "9");
  const picker = tools.target.querySelector<HTMLButtonElement>(".table-size-picker");
  picker?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  flushSync();
  expect(tools.button("插入表格").disabled).toBe(false);
  tools.button("插入表格").click();
  expect(tools.view.state.doc.child(1).childCount).toBe(7);
  expect(tools.view.state.doc.child(1).firstChild?.childCount).toBe(8);
});

it("正文事务映射原插入书签，确认不跟随后来移动到另一段的光标", () => {
  const tools = toolbar();
  tools.open();
  tools.view.dispatch(tools.view.state.tr.insertText("新增", 1));
  tools.view.dispatch(tools.view.state.tr.setSelection(TextSelection.atEnd(tools.view.state.doc)));
  flushSync();
  tools.button("插入表格").click();
  expect(tools.view.state.doc.child(0).textContent).toBe("新增前文");
  expect(tools.view.state.doc.child(1).type.name).toBe("table");
  expect(tools.view.state.doc.child(2).textContent).toBe("后文");
});

it("原编辑器销毁或进入只读后拒绝迟到插入", () => {
  const locked = toolbar();
  locked.open();
  const original = locked.view.state.doc;
  setDocumentReadOnly(locked.view, true);
  flushSync();
  locked.button("插入表格").click();
  flushSync();
  expect(locked.view.state.doc.eq(original)).toBe(true);
  expect(locked.target.querySelector('[role="alert"]')?.textContent).toContain("正文");
  locked.button("取消插入表格").click();
  const destroyed = toolbar();
  destroyed.open();
  destroyed.view.destroy();
  destroyed.button("插入表格").click();
  flushSync();
  expect(destroyed.target.querySelector('[role="alert"]')?.textContent).toContain("原文档");
});
