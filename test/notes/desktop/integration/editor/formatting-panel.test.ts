/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import Harness from "./EditorFormattingHarness.svelte";

it("编辑工具栏常驻，随选区更新格式状态，应用命令后仍保持可用", async () => {
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("正文") }),
    handleScrollToSelection: () => true,
  });
  const state = writable(view.state);
  const app = mount(Harness, { target, props: { view, state } });
  try {
    flushSync();
    expect(target.querySelector('[role="toolbar"][aria-label="编辑工具栏"]')).not.toBeNull();
    expect(target.querySelectorAll("[popover]")).toHaveLength(2);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    state.set(view.state);
    flushSync();
    const bold = target.querySelector<HTMLButtonElement>('[aria-label="加粗"]')!;
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    bold.click();
    state.set(view.state);
    flushSync();
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(view.state.doc.textContent).toBe("正文");
    expect(target.querySelector('[aria-label="插入表格"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="插入附件…"]')).not.toBeNull();
  } finally {
    await unmount(app);
    view.destroy();
    host.remove();
    target.remove();
    vi.restoreAllMocks();
  }
});
