/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { writingCommands } from "@reader/renderer/engine/editing/writing";
import Harness from "./EditorFormattingHarness.svelte";

it("关闭的格式面板不计算命令状态，重新打开使用最新选区", async () => {
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const view = new EditorView(host, { state: EditorState.create({ doc: parseMarkdown("正文") }) });
  const state = writable(view.state);
  const check = vi.spyOn(writingCommands, "taskList");
  const app = mount(Harness, { target, props: { view, state } });
  try {
    flushSync();
    for (let index = 0; index < 10; index++) {
      view.dispatch(view.state.tr.insertText("新"));
      state.set(view.state);
      flushSync();
    }
    expect(check.mock.calls.length).toBe(0);
    const panel = target.querySelector<HTMLDivElement>("[popover]")!;
    // jsdom 不实现原生 popover；这里只模拟生命周期，原生焦点行为由 Electron 验收。
    const toggle = (newState: "open" | "closed") => {
      panel.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState }));
      panel.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
      flushSync();
    };
    toggle("open");
    expect(check).toHaveBeenCalledOnce();
    expect(target.querySelector('button[aria-label="加粗"]')?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    toggle("closed");
    check.mockClear();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    writingCommands.bold(view.state, view.dispatch);
    state.set(view.state);
    flushSync();
    expect(check.mock.calls.length).toBe(0);
    toggle("open");
    expect(check).toHaveBeenCalledOnce();
    expect(target.querySelector('button[aria-label="加粗"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  } finally {
    await unmount(app);
    view.destroy();
    host.remove();
    target.remove();
    vi.restoreAllMocks();
  }
});
