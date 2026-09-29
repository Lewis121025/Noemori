<script lang="ts">
  /** 读写中的轻量导航；只负责快速打开，管理页面的多选、展开和查询现场独立保留。 */
  import Sidebar from "../library/Sidebar.svelte";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { rankSwitcher, switcherEntries } from "./switcher";
  import { createCompositionGuard } from "../editor/composition";
  import { SvelteSet } from "svelte/reactivity";
  import { isWhiteboardPath } from "../whiteboard/model";
  let {
    workspace,
    hidden,
    width,
    onWidth,
    onLibrary,
    onOpen,
  }: {
    workspace: ReaderWorkspaceController;
    hidden: boolean;
    width: number;
    onWidth: (width: number) => void;
    onLibrary: () => void;
    onOpen: (path: string) => void;
  } = $props();
  let query = $state("");
  let focused = $state<string | null>(null);
  let list: HTMLUListElement;
  let searchInput: HTMLInputElement;
  const composition = createCompositionGuard();
  const busy = $derived(workspace.switching || workspace.copying || workspace.isComposing);
  const entries = $derived(
    switcherEntries(
      workspace.files.filter((path) => !isWhiteboardPath(path)),
      workspace.noteKeys,
    ),
  );
  const hits = $derived(rankSwitcher(query, entries, workspace.recentFiles).slice(0, 20));
  const focusable = $derived(
    hits.some((hit) => hit.entry.path === focused)
      ? focused
      : hits.some((hit) => hit.entry.path === workspace.document.path)
        ? workspace.document.path
        : hits[0]?.entry.path,
  );
  const duplicateLabels = $derived.by(() => {
    const seen = new SvelteSet<string>();
    const duplicates = new SvelteSet<string>();
    for (const entry of entries) {
      if (seen.has(entry.label)) duplicates.add(entry.label);
      seen.add(entry.label);
    }
    return duplicates;
  });

  function open(path: string): void {
    if (!busy && !composition.active) onOpen(path);
  }
  function clearSearch(): void {
    if (composition.active) return;
    query = "";
    searchInput.focus();
  }
  function focusRow(index: number): void {
    list.querySelectorAll<HTMLButtonElement>(".file")[index]?.focus();
  }
  function searchKeydown(event: KeyboardEvent): void {
    if (composition.active) return event.stopPropagation();
    if (busy || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" && hits[0] !== undefined) {
      event.preventDefault();
      open(hits[0].entry.path);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(event.key === "ArrowDown" ? 0 : hits.length - 1);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    }
  }
  /** 焦点浏览不打开文件；确认仍交由按钮的原生 Enter / Space 行为。 */
  function rowKeydown(event: KeyboardEvent, index: number): void {
    if (composition.active) return event.stopPropagation();
    if (busy || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      searchInput.focus();
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, hits.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? hits.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    focusRow(next);
  }
</script>

<Sidebar {width} {onWidth} {hidden}>
  <nav class="quick-navigation" aria-label="文件列表" use:composition.bind>
    <div class="search">
      <input
        class="reader-input"
        type="text"
        role="searchbox"
        aria-label="快速查找文件"
        placeholder="查找笔记…"
        bind:this={searchInput}
        bind:value={query}
        onkeydown={searchKeydown}
      />
      {#if query !== ""}
        <button class="clear-search" type="button" aria-label="清除快速查找" onclick={clearSearch}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
        </button>
      {/if}
    </div>
    <p class="caption">{query.trim() === "" ? "笔记" : "查找结果"}</p>
    <ul role="tree" aria-label="快速打开笔记" bind:this={list}>
      {#each hits as { entry }, index (entry.path)}
        <li role="none">
          <button
            class="file"
            class:active={entry.path === workspace.document.path}
            type="button"
            role="treeitem"
            data-path={entry.path}
            title={entry.path}
            aria-label={duplicateLabels.has(entry.label)
              ? `${entry.path.split("/").at(-1)} · ${entry.directory || "根目录"}`
              : entry.path.split("/").at(-1)}
            aria-current={entry.path === workspace.document.path ? "page" : undefined}
            aria-selected={entry.path === workspace.document.path}
            tabindex={entry.path === focusable ? 0 : -1}
            disabled={busy}
            onfocus={() => (focused = entry.path)}
            onkeydown={(event) => rowKeydown(event, index)}
            onclick={() => open(entry.path)}
            ><span>{entry.label}</span>
            {#if duplicateLabels.has(entry.label)}<span class="directory"
                >{entry.directory || "根目录"}</span
              >{/if}</button
          >
        </li>
      {:else}
        <li role="none">
          <div class="empty" role="status">
            {#if query.trim() !== ""}
              <strong>没有匹配的笔记</strong>
              <span>试试其他名称，或到资料管理搜索正文。</span>
            {:else}
              <span
                >{workspace.vaultRoot === null
                  ? "开始记录，或打开已有资料。"
                  : "新建一篇笔记，从一个想法开始。"}</span
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <button class="reader-button library-link" type="button" onclick={onLibrary}
      >全部资料 <span aria-hidden="true">↗</span></button
    >
  </nav>
</Sidebar>

<style>
  .quick-navigation {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    padding: 1.5rem 0.9rem;
    background: var(--sidebar);
  }
  .search {
    position: relative;
  }
  .search input {
    width: 100%;
    font-size: 0.8rem;
    padding-right: 2rem;
  }
  .clear-search {
    position: absolute;
    right: 0.3rem;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    padding: 0.2rem;
    border: none;
    border-radius: 0.3rem;
    color: var(--muted);
    background: transparent;
    cursor: pointer;
  }
  .clear-search:hover {
    background: var(--selected);
  }
  .clear-search svg {
    width: 1rem;
    height: 1rem;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .caption {
    color: var(--muted);
    font-size: 0.75rem;
    margin: 1.25rem 0.5rem 0.5rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .file {
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    width: 100%;
    text-align: left;
    padding: 0.7rem 0.7rem;
    border-radius: 7px;
    cursor: pointer;
  }
  .file span {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .file:hover {
    background: var(--selected);
  }
  .file[aria-selected="true"] {
    background: var(--surface);
    box-shadow: 0 1px 4px var(--shadow);
  }
  .search :global(.reader-input) {
    background: color-mix(in srgb, var(--surface) 50%, transparent);
    border-color: transparent;
  }
  .directory {
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.2rem;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.65rem 0.5rem;
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--muted);
  }
  .empty strong {
    color: var(--fg);
    font-weight: 500;
  }
  .library-link {
    margin-top: 1rem;
    font-size: 0.8rem;
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
  }
</style>
