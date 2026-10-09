<script lang="ts">
  import type { EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import {
    articleConversationId,
    type ArticleConversationPreview,
    type ArticleEditorActions,
  } from "../../../shared/article-conversations";
  import { createHoverController } from "../../preview/hover-preview";
  let {
    view,
    state: editorState,
    actions,
  }: {
    view: EditorView;
    state: EditorState;
    actions: Pick<ArticleEditorActions, "preview" | "open" | "report">;
  } = $props();
  let shown = $state.raw<{ id: string; element: HTMLAnchorElement; rect: DOMRect } | null>(null);
  let previewHeight = $state(230);
  let preview = $state.raw<ArticleConversationPreview | null>(null);
  let previewError = $state("");
  let popover: HTMLElement | undefined = $state();
  const hover = createHoverController<{ id: string; element: HTMLAnchorElement }>({
    show: (hit) => {
      shown = { ...hit, rect: hit.element.getBoundingClientRect() };
    },
    hide: () => {
      shown = null;
    },
    same: (a, b) => a.element === b.element,
  });

  /** 关闭当前文章对话浮层，不改变正文或会话。 */
  export function dismiss(): void {
    hover.dismiss();
  }
  function leaveContext(event: Event): void {
    const target = event.target;
    if (target instanceof Node && (view.dom.contains(target) || popover?.contains(target))) return;
    hover.dismiss();
  }
  function hit(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    const id = element ? articleConversationId(element.getAttribute("href") ?? "") : null;
    return element && id ? { element, id } : null;
  }
  async function enter(id: string): Promise<void> {
    hover.dismiss();
    try {
      await actions.open(id);
    } catch (cause) {
      actions.report(String(cause));
    }
  }
  $effect(() => {
    const editor = view;
    const over = (event: Event) => {
      const found = hit(event.target);
      if (found) hover.enterLink(found);
    };
    const out = (event: PointerEvent) => {
      const found = hit(event.target);
      if (
        found &&
        !(event.relatedTarget instanceof Node && found.element.contains(event.relatedTarget))
      )
        hover.leaveLink();
    };
    const click = (event: MouseEvent) => {
      const found = hit(event.target);
      if (!found) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void enter(found.id);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hover.dismiss();
    };
    editor.dom.addEventListener("pointerover", over);
    editor.dom.addEventListener("pointerout", out);
    editor.dom.addEventListener("focusin", over);
    editor.dom.addEventListener("click", click, true);
    editor.dom.addEventListener("keydown", key);
    return () => {
      editor.dom.removeEventListener("pointerover", over);
      editor.dom.removeEventListener("pointerout", out);
      editor.dom.removeEventListener("focusin", over);
      editor.dom.removeEventListener("click", click, true);
      editor.dom.removeEventListener("keydown", key);
      hover.dismiss();
    };
  });
  $effect(() => {
    const selection = editorState.selection;
    if (!view.hasFocus() || !selection.empty) return;
    const dom = view.domAtPos(selection.from).node;
    const found = hit(dom instanceof Element ? dom : dom.parentElement);
    if (found) hover.enterLink(found);
    else hover.dismiss();
  });
  $effect(() => {
    const current = shown;
    preview = null;
    previewError = "";
    if (!current) return;
    let live = true;
    void actions.preview(current.id).then(
      (item) => {
        if (live) preview = item;
      },
      (cause) => {
        if (live) previewError = String(cause);
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<svelte:document onfocusin={leaveContext} onpointerdown={leaveContext} />
<svelte:window
  onscroll={() => hover.dismiss()}
  onresize={() => hover.dismiss()}
  onblur={() => hover.dismiss()}
/>
{#if shown}<aside
    bind:this={popover}
    bind:offsetHeight={previewHeight}
    class="conversation-preview"
    aria-label="文章对话预览"
    style:left={`${Math.max(8, Math.min(shown.rect.left, window.innerWidth - 344))}px`}
    style:top={`${shown.rect.bottom + previewHeight + 16 <= window.innerHeight ? shown.rect.bottom + 8 : Math.max(8, shown.rect.top - previewHeight - 8)}px`}
    onpointerenter={() => hover.enterPopover()}
    onpointerleave={() => hover.leavePopover()}
  >
    <span class="eyebrow">文章对话{preview?.archived ? " · 已归档" : ""}</span>
    <strong>{preview?.title ?? "正在读取…"}</strong>
    {#if preview?.article}<span class="eyebrow">所属文章：{preview.article.title}</span>{/if}
    <p>{previewError || preview?.excerpt || "正在读取…"}</p>
    <button
      class="reader-button primary"
      type="button"
      disabled={!preview}
      onclick={() => {
        if (shown) void enter(shown.id);
      }}>打开对话</button
    >
  </aside>{/if}

<style>
  p {
    margin: 0;
    line-height: 1.7;
    font-size: 0.82rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .conversation-preview {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: min(21rem, calc(100vw - 1rem));
    max-height: 230px;
    overflow: auto;
    padding: 1rem;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 8px 28px var(--shadow);
  }
  .eyebrow {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .conversation-preview strong {
    font-size: 0.9rem;
  }
  .conversation-preview button {
    align-self: flex-end;
  }
</style>
