/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import EditorWebPage from "@reader/renderer/editor/webpage/EditorWebPage.svelte";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { createLinkSelectionPlugin, linkSelectionKey } from "@reader/renderer/editor/links/link-editing";

const linkSelectionPlugin = createLinkSelectionPlugin();

let view: EditorView;
let panel: ReturnType<typeof mount> | undefined;
const closed = vi.fn();

beforeEach(() => {
  const editorHost = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(editorHost, controls);
  view = new EditorView(editorHost, {
    state: EditorState.create({ doc: parseMarkdown("前文后文"), plugins: [linkSelectionPlugin] }),
  });
  panel = mount(EditorWebPage, { target: controls, props: { view, onClose: closed } });
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("网页对话框未挂载");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  flushSync();
});
afterEach(async () => {
  if (panel) await unmount(panel);
  if (!view.isDestroyed) view.destroy();
  document.body.replaceChildren(); closed.mockClear();
});

it("输入法确认不提交网页或关闭弹窗，取消保留正文", () => {
  const input = document.querySelector("input");
  const form = document.querySelector("form");
  const dialog = document.querySelector("dialog");
  if (!input || !form || !dialog) throw new Error("网页控件不完整");
  input.value = "https://example.com";
  input.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
  const original = view.state.doc;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  form.requestSubmit();
  dialog.dispatchEvent(new Event("cancel", { cancelable: true })); flushSync();
  expect(closed).not.toHaveBeenCalled();
  expect(view.state.doc.eq(original)).toBe(true);
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  dialog.dispatchEvent(new Event("cancel", { cancelable: true })); flushSync();
  expect(closed).toHaveBeenCalledOnce();
  expect(view.state.doc.eq(original)).toBe(true);
});

it("原编辑会话销毁后，迟到提交只提示重新选择，不向其他文档插入", () => {
  const input = document.querySelector("input");
  const form = document.querySelector("form");
  if (!input || !form) throw new Error("网页控件不完整");
  input.value = "https://example.com";
  input.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
  view.destroy();
  form.requestSubmit(); flushSync();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("原文档已重新加载");
  expect(closed).not.toHaveBeenCalled();
});

it("关闭立即释放选区，尾帧卸载不清掉后来弹窗取得的新选区", async () => {
  const dialog = document.querySelector("dialog");
  if (!dialog || !panel) throw new Error("缺少网页弹窗");
  expect(linkSelectionKey.getState(view.state)).not.toBeNull();
  dialog.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "closed" }));
  expect(linkSelectionKey.getState(view.state)).toBeNull();
  view.dispatch(view.state.tr.setMeta(linkSelectionKey, true));
  const nextOwner = linkSelectionKey.getState(view.state);
  await unmount(panel);
  panel = undefined;
  expect(linkSelectionKey.getState(view.state)).toBe(nextOwner);
});
