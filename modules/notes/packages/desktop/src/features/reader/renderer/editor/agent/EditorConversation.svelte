<script lang="ts">
  import { tick } from "svelte";
  import type { EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { closeHistory } from "prosemirror-history";
  import { articleConversationHref } from "../../../shared/article-conversations";
  import type { ArticleConversationPreview } from "../../../shared/article-conversations";
  import type { ArticleEditorActions } from "../../../shared/article-conversations";
  import { createCompositionGuard } from "../../../shared/composition";
  import { canUseEditingTools } from "../read-only";
  import ConversationPreview from "./ConversationPreview.svelte";
  import { conversationInsertion } from "./insertion";
  let {
    view,
    state: editorState,
    actions,
  }: { view: EditorView; state: EditorState; actions: ArticleEditorActions } = $props();
  let dialog: HTMLDialogElement;
  let nameInput: HTMLInputElement;
  const fieldId = $props.id();
  let title = $state("");
  let busy = $state(false);
  let error = $state("");
  let origin: EditorView | null = null;
  const composition = createCompositionGuard();
  let hoverPreview: ConversationPreview | undefined = $state();
  /** 打开名称确认并保留所属编辑器选区；取消不创建会话或改动文章。 */
  export async function open(): Promise<void> {
    if (
      view.composing ||
      !canUseEditingTools(view.state) ||
      view.state.selection.$to.parent.type.spec.code
    )
      return;
    view.dispatch(
      view.state.tr
        .setMeta(conversationInsertion, view.state.selection.to)
        .setMeta("addToHistory", false),
    );
    origin = view;
    title = "段落讨论";
    error = "";
    hoverPreview?.dismiss();
    dialog.showModal();
    await tick();
    nameInput.focus();
    nameInput.select();
  }
  async function create(): Promise<void> {
    if (busy || composition.active || !title.trim() || !origin) return;
    const target = origin;
    let item: ArticleConversationPreview | null = null;
    let inserted = false;
    busy = true;
    error = "";
    try {
      item = await actions.create(title.trim());
      if (target.isDestroyed || target !== view || !canUseEditingTools(target.state))
        throw new Error("文章已切换，未插入对话，请重新选择位置");
      const position = conversationInsertion.getState(target.state);
      if (position == null) throw new Error("原位置已被删除，请重新选择正文位置");
      if (!target.state.doc.resolve(position).parent.inlineContent)
        throw new Error("原位置已变化，请重新选择正文位置");
      const link = target.state.schema.mark("link", { href: articleConversationHref(item.id) });
      target.dispatch(
        closeHistory(target.state.tr).insert(
          position,
          target.state.schema.text(`讨论：${item.title}`, [link]),
        ),
      );
      target.dispatch(
        closeHistory(target.state.tr)
          .setMeta(conversationInsertion, null)
          .setMeta("addToHistory", false),
      );
      inserted = true;
      dialog.close();
      await actions.open(item.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (item && !inserted) {
        try {
          await actions.discard(item.id);
        } catch (cleanup) {
          actions.report(`空对话未能清理：${String(cleanup)}`);
        }
      }
      if (inserted)
        actions.report(
          `对话入口已插入，文章保存或打开失败：${message}。请保存后点击入口，不需要重复创建。`,
        );
      else error = message;
    } finally {
      busy = false;
    }
  }
</script>

<ConversationPreview bind:this={hoverPreview} {view} state={editorState} {actions} />
<dialog
  aria-labelledby={`${fieldId}-title`}
  bind:this={dialog}
  use:composition.bind
  oncancel={(event) => {
    if (busy || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <h2 id={`${fieldId}-title`}>在此处插入对话</h2>
    <p>对话属于这篇文章，记录随笔记库保存。助手会收到文章路径和此处段落的内容。</p>
    <label for={`${fieldId}-name`}>对话名称</label>
    <input
      class="reader-input"
      id={`${fieldId}-name`}
      bind:this={nameInput}
      bind:value={title}
      maxlength="120"
      disabled={busy}
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button class="reader-button" type="button" disabled={busy} onclick={() => dialog.close()}
        >取消</button
      ><button class="reader-button primary" type="submit" disabled={busy || !title.trim()}
        >{busy ? "正在创建…" : "插入对话"}</button
      >
    </footer>
  </form>
</dialog>

<style>
  dialog {
    width: min(28rem, calc(100vw - 2rem));
    padding: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--fg);
    background: var(--bg);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  p {
    margin: 0;
    line-height: 1.7;
    font-size: 0.82rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  label {
    font-size: 0.8rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .error {
    color: var(--danger);
  }
</style>
