<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import { createCompositionGuard } from "../composition";
  import { linkSelectionKey } from "../links/link-editing";
  import { insertWebPage } from "./insert";
  import { dialogEnter, dialogExit, finishOnReducedMotion } from "../../transition-lifecycle";

  let { view, onClose }: { view: EditorView; onClose: () => void } = $props();
  const owner = untrack(() => view);
  let url = $state("");
  let height = $state(480);
  let error = $state("");
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  const composition = createCompositionGuard();
  let ownsSelection = false;

  function releaseSelection(): void {
    if (!ownsSelection) return;
    ownsSelection = false;
    if (!owner.isDestroyed) owner.dispatch(owner.state.tr.setMeta(linkSelectionKey, false));
  }

  onMount(() => {
    ownsSelection = true;
    owner.dispatch(owner.state.tr.setMeta(linkSelectionKey, true));
    dialog.showModal();
    input.focus();
    return releaseSelection;
  });
  function close(): void {
    if (composition.active) return;
    dialog.close();
    onClose();
    view.focus();
  }
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (composition.active) return;
    try {
      if (view !== owner || owner.isDestroyed) {
        error = "原文档已重新加载，请关闭后重新选择插入位置";
        return;
      }
      const bookmark = linkSelectionKey.getState(view.state);
      if (bookmark) view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
      if (!insertWebPage({ url: url.trim(), height })(view.state, view.dispatch, view)) {
        error = "请在普通正文中放置光标；代码块、表格和跨段选区不能插入网页";
        return;
      }
      close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<dialog
  in:dialogEnter|global
  out:dialogExit|global
  use:finishOnReducedMotion
  onbeforetoggle={(event) => {
    if (event.newState === "closed") releaseSelection();
  }}
  bind:this={dialog}
  class="reader-dialog"
  aria-label="插入网页"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <form onsubmit={submit} use:composition.bind>
    <h2>插入网页</h2>
    <label
      >网页地址
      <input
        bind:this={input}
        class="reader-input"
        type="url"
        bind:value={url}
        placeholder="https://example.com"
        required
      />
    </label>
    <label
      >显示高度（像素）
      <input
        class="reader-input"
        type="number"
        bind:value={height}
        min="240"
        max="1200"
        step="1"
        required
      />
    </label>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      <button class="reader-button" type="button" onclick={close}>取消</button>
      <button class="reader-button" type="submit">插入</button>
    </div>
  </form>
</dialog>

<style>
  form {
    display: grid;
    gap: 0.75rem;
    min-width: min(24rem, 75vw);
  }
  h2 {
    font-size: 1rem;
    margin: 0;
  }
  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  p {
    color: var(--danger);
    margin: 0;
  }
</style>
