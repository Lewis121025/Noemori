<script lang="ts">
  /** 查找状态由插件持有，替换仍走同一事务和撤销栈；输入框保留焦点。 */
  import { onMount } from "svelte";
  import type { Command, EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { SearchQuery, setSearchState } from "prosemirror-search";
  import {
    findNextMatch,
    findPreviousMatch,
    searchMatches,
  } from "../../engine/editing/search-navigation";
  import { replaceSearch } from "../../engine/editing/search-replace";
  import { createCompositionGuard, isCompositionKey } from "../../engine/editing/composition";
  import { focusDocument } from "../../engine/editing/read-only";

  let {
    view,
    state: editorState,
    onClose,
    readOnly = false,
  }: { view: EditorView; state: EditorState; onClose: () => void; readOnly?: boolean } = $props();
  let term = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let showReplace = $state(false);
  let input: HTMLInputElement;
  let form: HTMLFormElement;
  const replaceId = $props.id();
  const statusId = `${replaceId}-status`;
  const composition = createCompositionGuard();
  const query = $derived(
    new SearchQuery({ search: term, replace: replacement, caseSensitive, literal: true }),
  );
  const matches = $derived(searchMatches(editorState));
  const current = $derived(
    matches.findIndex(
      (match) => match.from === editorState.selection.from && match.to === editorState.selection.to,
    ) + 1,
  );
  const hasMatch = $derived(matches.length > 0);
  const status = $derived(
    term === ""
      ? ""
      : !hasMatch
        ? "没有匹配项"
        : current === 0
          ? `共 ${matches.length} 处`
          : `第 ${current} 处，共 ${matches.length} 处`,
  );

  $effect(() => {
    view.dispatch(setSearchState(view.state.tr, query));
  });
  onMount(() => {
    const { from, to } = view.state.selection;
    term = view.state.doc.textBetween(from, to, " ");
    focusQuery();
    form.addEventListener("keydown", onKey);
    return () => form.removeEventListener("keydown", onKey);
  });
  $effect(() => {
    const current = view;
    const scrollMargin = current.props.scrollMargin ?? 5;
    const scrollThreshold = current.props.scrollThreshold ?? 0;
    const resize = new ResizeObserver(() => updateScrollMargin(current));
    resize.observe(form);
    return () => {
      resize.disconnect();
      if (!current.isDestroyed) {
        current.setProps({ scrollMargin, scrollThreshold });
        current.dispatch(setSearchState(current.state.tr, new SearchQuery({ search: "" })));
      }
    };
  });

  /** 再次查找时保留查询并选中输入，长文中滚到搜索栏以便直接改词。 */
  export function focusQuery(): void {
    input.focus();
    input.select();
  }

  // 布局通知晚于首次回车或替换行展开；执行定位前也读取当前高度，避免命中被搜索栏挡住。
  function updateScrollMargin(current: EditorView): void {
    const top = form.offsetHeight + 12;
    current.setProps({
      scrollMargin: { top, bottom: 12, left: 5, right: 5 },
      scrollThreshold: { top, bottom: 0, left: 0, right: 0 },
    });
  }

  function run(command: Command): void {
    if (composition.active) return;
    updateScrollMargin(view);
    // ProseMirror 只滚动编辑器内的 DOM 选区；执行后把焦点还给原控件且不再次滚动。
    const focused = document.activeElement;
    focusDocument(view);
    command(view.state, view.dispatch, view);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  function close(): void {
    if (composition.active) return;
    onClose();
    focusDocument(view);
  }
  function onKey(event: KeyboardEvent): void {
    if (composition.active || isCompositionKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      run(event.shiftKey ? findPreviousMatch : findNextMatch);
    }
  }
</script>

<form
  class="search-panel"
  bind:this={form}
  use:composition.bind
  aria-label="文内查找替换"
  onsubmit={(event) => event.preventDefault()}
>
  <div class="search-row">
    {#if !readOnly}
      <button
        class="reader-button icon-button"
        type="button"
        aria-label="替换选项"
        title="替换选项"
        aria-expanded={showReplace}
        aria-controls={replaceId}
        onclick={() => {
          if (!composition.active) showReplace = !showReplace;
        }}
      >
        <svg
          class="reader-icon disclosure"
          class:expanded={showReplace}
          viewBox="0 0 24 24"
          aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg
        >
      </button>
    {/if}
    <!-- 原生 search 在组词中收到 Escape 会清空内容且漏发 compositionend；清空由应用处理。 -->
    <input
      class="reader-input"
      aria-label="查找"
      aria-describedby={statusId}
      placeholder="查找文中内容"
      bind:this={input}
      type="text"
      role="searchbox"
      bind:value={term}
    />
    <button
      class="reader-button icon-button case-option"
      type="button"
      aria-label="区分大小写"
      title="区分大小写"
      aria-pressed={caseSensitive}
      onclick={() => {
        if (!composition.active) caseSensitive = !caseSensitive;
      }}>Aa</button
    >
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="上一处"
      title="上一处（Shift + Enter）"
      onclick={() => run(findPreviousMatch)}
      disabled={!hasMatch}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 14 6-6 6 6" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="下一处"
      title="下一处（Enter）"
      onclick={() => run(findNextMatch)}
      disabled={!hasMatch}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 10 6 6 6-6" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      onclick={close}
      aria-label="关闭查找"
      title="关闭查找（Esc）"
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 6 12 12M6 18 18 6" /></svg
      >
    </button>
  </div>
  {#if !readOnly}
    <div id={replaceId} class="replace-row" hidden={!showReplace}>
      <input
        class="reader-input"
        aria-label="替换为"
        placeholder="替换为"
        bind:value={replacement}
      />
      <button
        class="reader-button"
        type="button"
        onclick={() => run(replaceSearch(false))}
        disabled={!hasMatch}>替换</button
      >
      <button
        class="reader-button"
        type="button"
        onclick={() => run(replaceSearch(true))}
        disabled={!hasMatch}>全部替换</button
      >
    </div>
  {/if}
  <div class="search-status" id={statusId} role="status" aria-atomic="true">{status}</div>
</form>

<style>
  .search-panel {
    position: sticky;
    top: calc(-1 * var(--reader-inset, 0px));
    z-index: 1;
    padding: 0.5rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--bg);
    box-shadow: 0 2px 8px var(--shadow);
  }
  .search-row,
  .replace-row {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }
  .replace-row {
    padding: 0.5rem 0 0 2.25rem;
    gap: 0.4rem;
  }
  .replace-row[hidden] {
    display: none;
  }
  input {
    flex: 1;
    width: 0;
    padding: 0.35rem 0.5rem;
    background: var(--sidebar);
    border-color: transparent;
  }
  button {
    flex-shrink: 0;
    font-size: 0.85rem;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-color: transparent;
    background: transparent;
  }
  .case-option[aria-pressed="true"] {
    background: var(--selected);
    color: var(--accent);
  }
  .expanded {
    transform: rotate(90deg);
  }
  .search-status {
    color: var(--muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    padding: 0.4rem 0.25rem 0;
  }
  .search-status:empty {
    display: none;
  }
  @media (max-width: 640px) {
    .replace-row {
      padding-left: 0;
    }
  }
</style>
