/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import EditorConversation from "../../../../modules/notes/packages/desktop/src/features/reader/renderer/editor/agent/EditorConversation.svelte";
import { conversationInsertionPlugin } from "../../../../modules/notes/packages/desktop/src/features/reader/renderer/editor/agent/insertion";
import { parseMarkdown } from "../../../../modules/notes/packages/desktop/src/features/reader/shared/markdown/parse";
import type {
  ArticleEditorActions,
  ArticleConversationPreview,
} from "../../../../modules/notes/packages/desktop/src/features/reader/shared/article-conversations";

it("双栏的创建表单和插入点各自独立，取消不会创建记录或改动另一篇文章", async (test) => {
  // jsdom 没有原生对话框实现；此文件的独立 DOM 环境只模拟开合，不改动业务状态。
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const mounts: {
    target: HTMLDivElement;
    view: EditorView;
    component: EditorConversation;
    actions: ArticleEditorActions;
  }[] = [];
  for (const name of ["甲文章", "乙文章"]) {
    const target = document.createElement("div"),
      editor = document.createElement("div");
    target.append(editor);
    document.body.append(target);
    const view = new EditorView(editor, {
      state: EditorState.create({
        doc: parseMarkdown(name),
        plugins: [conversationInsertionPlugin()],
      }),
    });
    const item: ArticleConversationPreview = {
      id: "33333333-3333-4333-8333-333333333333",
      title: "第二栏讨论",
      workspace: "/库",
      archived: false,
      article: { path: `${name}.md`, title: name },
      excerpt: "",
      messages: [],
    };
    const actions: ArticleEditorActions = {
      create: vi.fn(async () => item),
      discard: vi.fn(),
      preview: vi.fn(async () => item),
      open: vi.fn(),
      report: vi.fn(),
    };
    const component = mount(EditorConversation, {
      target,
      props: { view, state: view.state, actions },
    });
    mounts.push({ target, view, component, actions });
  }
  test.onTestFinished(async () => {
    for (const item of mounts) {
      await unmount(item.component);
      item.view.destroy();
      item.target.remove();
    }
  });
  flushSync();
  const first = mounts[0]!,
    second = mounts[1]!;
  await first.component.open();
  first.target.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  expect(first.actions.create).not.toHaveBeenCalled();
  await second.component.open();
  const field = second.target.querySelector("input")!;
  expect(second.target.querySelector("label")!.control).toBe(field);
  expect(field.id).not.toBe(first.target.querySelector("input")!.id);
  field.value = "第二栏讨论";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  second.target
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(second.actions.open).toHaveBeenCalledOnce());
  expect(first.view.state.doc.textContent).toBe("甲文章");
  expect(second.view.state.doc.textContent).toContain("讨论：第二栏讨论");
  expect(second.actions.create).toHaveBeenCalledExactlyOnceWith("第二栏讨论");
});

it("焦点离开文章会取消待弹出的对话预览，进入预览按钮仍可继续操作", async (test) => {
  const { default: ConversationPreview } = await import("../../../../modules/notes/packages/desktop/src/features/reader/renderer/editor/agent/ConversationPreview.svelte");
  vi.useFakeTimers();
  const target = document.createElement("div"), editor = document.createElement("div"), outside = document.createElement("input");
  target.append(editor, outside); document.body.append(target);
  const id = "33333333-3333-4333-8333-333333333333";
  const view = new EditorView(editor, { state: EditorState.create({ doc: parseMarkdown(`段落 [讨论](noemori://conversation/${id})`) }) });
  const preview = vi.fn(async (): Promise<ArticleConversationPreview> => ({ id, title: "讨论", workspace: "/库", archived: false, article: { path: "文章.md", title: "文章" }, excerpt: "内容", messages: [] }));
  const component = mount(ConversationPreview, { target, props: { view, state: view.state, actions: { preview, open: vi.fn(), report: vi.fn() } } });
  test.onTestFinished(async () => { await unmount(component); view.destroy(); target.remove(); vi.useRealTimers(); });
  flushSync();
  const marker = editor.querySelector("a")!;
  marker.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(399);
  outside.focus();
  await vi.advanceTimersByTimeAsync(2); flushSync();
  expect(preview).not.toHaveBeenCalled();
  marker.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(400); flushSync();
  const button = target.querySelector<HTMLButtonElement>(".conversation-preview button")!;
  button.focus(); flushSync();
  expect(target.querySelector(".conversation-preview")).not.toBeNull();
  outside.focus(); flushSync();
  expect(target.querySelector(".conversation-preview")).toBeNull();
});
