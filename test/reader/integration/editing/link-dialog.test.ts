/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import EditorLink from "@reader/renderer/components/editors/EditorLink.svelte";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { createAttachmentEditing } from "@reader/renderer/engine/editing/attachments";
import {
  linkSelectionKey,
  linkSelectionPlugin,
} from "@reader/renderer/engine/editing/link-editing";

let view: EditorView;
let panel: ReturnType<typeof mount> | undefined;
let attachments: ReturnType<typeof createAttachmentEditing>;
const onClose = vi.fn();

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`缺少控件：${selector}`);
  return found;
}

beforeEach(() => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(host, controls);
  const doc = parseMarkdown("前 [原链接](https://example.com) 后\n");
  attachments = createAttachmentEditing({
    import: async (name) => ({ path: `attachments/${name}`, warning: null }),
    progress: () => {},
    report: () => {},
  });
  view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 4),
      plugins: [attachments.plugin, linkSelectionPlugin],
    }),
  });
  panel = mount(EditorLink, { target: controls, props: { view, targets: [], onClose } });
  // jsdom 没有原生对话框，模态焦点与默认按键动作另由 Electron 验证。
  const dialog = element("dialog", HTMLDialogElement);
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  flushSync();
});

afterEach(async () => {
  if (panel) await unmount(panel);
  panel = undefined;
  view.destroy();
  document.body.replaceChildren();
  onClose.mockClear();
  vi.restoreAllMocks();
});

it.each(["提交", "取消按钮", "取消事件", "移除链接"])(
  "组词期间%s不修改正文或关闭弹窗",
  (action) => {
    const input = element("input", HTMLInputElement);
    const dialog = element("dialog", HTMLDialogElement);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const doc = view.state.doc;
    const selection = view.state.selection;
    const run = () => {
      if (action === "提交") element("form", HTMLFormElement).requestSubmit();
      else if (action === "取消事件") {
        const event = new Event("cancel", { cancelable: true });
        dialog.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      } else
        element(
          action === "移除链接" ? ".remove-link" : ".actions button:nth-last-child(2)",
          HTMLButtonElement,
        ).click();
      flushSync();
    };
    run();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(view.state.doc.eq(doc)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    run();
    expect(onClose).toHaveBeenCalledOnce();
    expect(view.hasFocus()).toBe(true);
  },
);

it.each(["Enter", "Escape"])("输入法结束键 %s 的默认动作不提交或关闭，松键后正常响应", (key) => {
  const input = element("input", HTMLInputElement);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  const keydown = new KeyboardEvent("keydown", {
    key,
    keyCode: 229,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(keydown);
  expect(keydown.defaultPrevented).toBe(false);
  const run = () =>
    key === "Enter"
      ? element("form", HTMLFormElement).requestSubmit()
      : element("dialog", HTMLDialogElement).dispatchEvent(
          new Event("cancel", { cancelable: true }),
        );
  run();
  expect(onClose).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  run();
  expect(onClose).toHaveBeenCalledOnce();
});

it("弹窗期间正文发生异步事务，取消仍恢复映射后的原光标", () => {
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    errors.push(event.message);
  };
  window.addEventListener("error", onError);
  try {
    view.dispatch(view.state.tr.insertText("异步", 1));
    element("dialog", HTMLDialogElement).dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(errors).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.from).toBe(6);
    expect(view.hasFocus()).toBe(true);
    expect(view.state.doc.textContent).toBe("异步前 原链接 后");
  } finally {
    window.removeEventListener("error", onError);
  }
});

it("原选区被删除时取消落在有效位置，卸载释放书签且不改变会话插件", async () => {
  view.dispatch(view.state.tr.delete(1, view.state.doc.content.size - 1));
  element("dialog", HTMLDialogElement).dispatchEvent(new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(view.state.selection.from).toBe(1);
  expect(view.state.selection.$from.doc).toBe(view.state.doc);
  if (panel) await unmount(panel);
  panel = undefined;
  expect(view.state.plugins).toEqual([attachments.plugin, linkSelectionPlugin]);
  expect(linkSelectionKey.getState(view.state)).toBeNull();
});

it("打开、取消链接不会结束附件会话或阻止之后的保存门禁", async () => {
  expect(await attachments.settle()).toBe(true);
  element("dialog", HTMLDialogElement).dispatchEvent(new Event("cancel", { cancelable: true }));
  if (panel) await unmount(panel);
  panel = undefined;
  expect(await attachments.settle()).toBe(true);
});
