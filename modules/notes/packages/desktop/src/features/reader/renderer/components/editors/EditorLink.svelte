<script lang="ts">
  /** 对话框存活期间沿用编辑器选区；提交验证失败时保留输入供修正。 */
  import { onMount } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import { TextSelection } from "prosemirror-state";
  import type { LinkKind } from "../../../shared/api";
  import {
    insertLink,
    selectedLink,
    removeLink,
    linkSelectionKey,
  } from "../../engine/editing/link-editing";
  import {
    rankFileCandidates,
    type LinkSuggestion,
  } from "../../engine/editing/link-suggest/candidates";
  import { createCompositionGuard, isCompositionKey } from "../../engine/editing/composition";

  let { view, targets, onClose }: { view: EditorView; targets: string[]; onClose: () => void } =
    $props();
  let kind = $state<LinkKind>("wiki");
  let target = $state("");
  let label = $state("");
  let error = $state("");
  let existing = $state(false);
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  const targetListId = $props.id();
  const composition = createCompositionGuard();

  /** 目标输入的补全候选；与编辑器内联补全共用同一排序。 */
  let suggestItems = $state<LinkSuggestion[]>([]);
  let suggestSelected = $state(0);
  let suggestOpen = $state(false);

  function refreshSuggest(): void {
    // 对话框里只在有输入时展示候选；空输入弹全量列表会干扰撤销等操作。
    if (kind !== "wiki" || target.trim() === "") {
      suggestOpen = false;
      return;
    }
    suggestItems = rankFileCandidates(target, targets);
    suggestSelected = 0;
    suggestOpen = suggestItems.length > 0;
  }

  function applySuggestion(index: number): void {
    const item = suggestItems[index];
    if (item === undefined) return;
    target = item.value;
    suggestOpen = false;
  }

  function moveSuggestion(delta: number): void {
    if (suggestItems.length === 0) return;
    suggestSelected = (suggestSelected + delta + suggestItems.length) % suggestItems.length;
  }

  function targetKeydown(event: KeyboardEvent): void {
    if (isCompositionKey(event) || composition.active) return;
    if (!suggestOpen || suggestItems.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (event.key === "Enter" || event.key === "Tab") {
      // 候选打开时 Enter 选择而不是提交表单；Tab 同样先消费给补全。
      event.preventDefault();
      event.stopPropagation();
      applySuggestion(suggestSelected);
    } else if (event.key === "Escape") {
      // 第一层 Escape 只收候选列表，再按才关对话框。
      event.preventDefault();
      event.stopPropagation();
      suggestOpen = false;
    }
  }

  onMount(() => {
    view.dispatch(view.state.tr.setMeta(linkSelectionKey, true));
    const { from, to } = view.state.selection;
    label = view.state.doc.textBetween(from, to);
    const link = selectedLink(view.state);
    if (link) {
      existing = true;
      kind = link.kind;
      target = link.target;
      label = link.label;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, link.from, link.to)),
      );
    }
    dialog.showModal();
    input.focus();
    return () => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(linkSelectionKey, false));
    };
  });
  function close(cancelled = true): void {
    if (composition.active) return;
    // 编辑已有链接时临时扩展了选区；取消必须回到进入对话框前的光标位置。
    const bookmark = linkSelectionKey.getState(view.state);
    if (cancelled && bookmark)
      view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
    dialog.close();
    onClose();
    view.focus();
  }
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (composition.active) return;
    try {
      if (!insertLink(target, label, kind)(view.state, view.dispatch, view)) {
        error = "请在同一段正文中选择文字或放置光标";
        return;
      }
      close(false);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<dialog
  bind:this={dialog}
  use:composition.bind
  aria-labelledby={`${targetListId}-title`}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <form onsubmit={submit}>
    <h2 id={`${targetListId}-title`}>{existing ? "编辑链接" : "插入链接"}</h2>
    <label
      >链接类型 <select class="reader-input" bind:value={kind} onchange={refreshSuggest}
        ><option value="wiki">库内笔记</option><option value="md">网页或文件</option></select
      ></label
    >
    <label
      >链接目标 <input
        bind:this={input}
        class="reader-input"
        bind:value={target}
        autocomplete="off"
        spellcheck="false"
        required
        role="combobox"
        aria-expanded={suggestOpen && suggestItems.length > 0}
        aria-controls={suggestOpen && suggestItems.length > 0 ? targetListId : undefined}
        placeholder={kind === "wiki" ? "选择或输入笔记路径" : "https:// 或相对路径"}
        oninput={refreshSuggest}
        onkeydown={targetKeydown}
      /></label
    >
    {#if suggestOpen && suggestItems.length > 0}
      <!-- 无障碍名称避开「链接目标」子串，防止与输入框标签在自动化定位中冲突。 -->
      <ul class="target-suggest" id={targetListId} role="listbox" aria-label="补全候选">
        {#each suggestItems as item, index (item.value)}
          <li
            role="option"
            aria-selected={index === suggestSelected}
            class:selected={index === suggestSelected}
            onmousedown={(event) => {
              event.preventDefault();
              applySuggestion(index);
            }}
            onmousemove={() => (suggestSelected = index)}
          >
            <span>{item.label}</span>
            {#if item.detail !== item.label}<span class="detail">{item.detail}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    <label
      >显示文字 <input
        class="reader-input"
        bind:value={label}
        placeholder="默认使用链接目标"
      /></label
    >
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      {#if existing}<button
          class="reader-button remove-link"
          type="button"
          onclick={() => {
            if (composition.active) return;
            removeLink(view.state, view.dispatch);
            close(false);
          }}>移除链接</button
        >{/if}
      <button class="reader-button" type="button" onclick={() => close()}>取消</button><button
        class="reader-button primary"
        type="submit">{existing ? "保存链接" : "插入"}</button
      >
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(28rem, calc(100vw - 2rem));
    border: 1px solid var(--border);
    border-radius: 0.85rem;
    background: var(--bg);
    color: var(--fg);
    padding: 1.5rem;
    box-shadow: 0 14px 50px var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  form,
  label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  form {
    gap: 0.9rem;
  }
  h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.35rem;
  }
  label {
    color: var(--muted);
    font-size: 0.85rem;
  }
  input,
  select {
    color: var(--fg);
    font-size: 1rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .remove-link {
    margin-right: auto;
    border-color: transparent;
    color: var(--muted);
  }
  p {
    color: var(--danger);
    margin: 0;
  }
  .target-suggest {
    list-style: none;
    margin: -0.4rem 0 0;
    padding: 0.25rem;
    max-height: 12rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg);
  }
  .target-suggest li {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .target-suggest li.selected {
    background: var(--selected);
  }
  .target-suggest .detail {
    color: var(--muted);
    font-size: 0.7rem;
    overflow-wrap: anywhere;
  }
</style>
