<script lang="ts">
  /** 当前笔记库的文件树；文件操作交给工作区，展开与搜索不影响资料管理的浏览现场。 */
  import Sidebar from "../library/Sidebar.svelte";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { tick, untrack } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  import FileTreeViewport from "../library/FileTreeViewport.svelte";
  import type { FileTreePosition } from "../../shared/file-browser";
  import {
    ancestorDirectories,
    buildFileTree,
    filterFileTree,
    visibleFileRows,
    type FileTreeRow,
  } from "../library/file-tree";
  import { createCompositionGuard } from "../editor/composition";
  let {
    workspace,
    hidden,
    width,
    onWidth,
    onOpen,
    onTrash,
  }: {
    workspace: ReaderWorkspaceController;
    hidden: boolean;
    width: number;
    onWidth: (width: number) => void;
    onOpen: (path: string) => void;
    /** 请求共用的删除确认框；侧栏不能直接移除文件或绕过保存门禁。 */
    onTrash: (entry: VaultEntry) => void;
  } = $props();
  let query = $state("");
  let focused = $state<string | null>(null);
  let viewport: FileTreeViewport | undefined = $state();
  let expanded = $state.raw<ReadonlySet<string>>(new Set());
  let position = $state.raw<FileTreePosition | null>(null);
  let searchPosition = $state.raw<FileTreePosition | null>(null);
  let previousRoot: string | null | undefined;
  let searchInput: HTMLInputElement;
  const composition = createCompositionGuard();
  const busy = $derived(workspace.switching || workspace.copying || workspace.isComposing);
  const active = $derived(workspace.document.path);
  const tree = $derived(buildFileTree(workspace.entries.filter((entry) => !entry.recoveryOnly)));
  const searching = $derived(query.trim() !== "");
  const rows = $derived(visibleFileRows(filterFileTree(tree, query), expanded, searching));
  const rootName = $derived(
    workspace.vaultRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? "文件目录",
  );
  const focusable = $derived(
    rows.some((row) => row.node.path === focused)
      ? focused
      : rows.some((row) => row.node.path === active)
        ? active
        : (rows[0]?.node.path ?? null),
  );

  $effect(() => {
    const root = workspace.vaultRoot;
    const path = active;
    untrack(() => {
      if (root !== previousRoot) {
        previousRoot = root;
        expanded = new Set();
        query = "";
        position = null;
        searchPosition = null;
      }
      // 链接、历史和分栏切换都跟随已提交的活动文档；不会提前改变保存失败时的选择。
      expanded = new Set([...expanded, ...ancestorDirectories(path)]);
      focused = path;
    });
  });

  $effect(() => {
    const path = active;
    const root = workspace.vaultRoot;
    if (hidden || path === null) return;
    let cancelled = false;
    // 先等待祖先展开，再做最小范围定位；文件已在视口内时保持原位置。
    void tick().then(() => {
      if (!cancelled && workspace.vaultRoot === root) void viewport?.revealPath(path);
    });
    return () => {
      cancelled = true;
    };
  });

  function toggle(path: string): void {
    expanded = expanded.has(path)
      ? new Set([...expanded].filter((item) => item !== path))
      : new Set([...expanded, path]);
  }
  function activate(row: FileTreeRow): void {
    if (busy || composition.active) return;
    if (row.node.kind === "directory") toggle(row.node.path);
    else onOpen(row.node.path);
  }
  function requestTrash(row: FileTreeRow): void {
    if (hidden || busy || composition.active) return;
    focused = row.node.path;
    onTrash({ path: row.node.path, kind: row.node.kind });
  }

  /** 删除提交并刷新目录后，将焦点交还现存条目；空目录交还搜索框，隐藏时不抢焦点。 */
  export async function focusFiles(): Promise<void> {
    await tick();
    if (hidden) return;
    if (focusable !== null) await viewport?.focusPath(focusable);
    else searchInput.focus();
  }
  function clearSearch(): void {
    if (composition.active) return;
    query = "";
    searchInput.focus();
  }
  function focusRow(index: number): void {
    const row = rows[index];
    if (row === undefined) return;
    focused = row.node.path;
    void viewport?.focusPath(row.node.path);
  }
  function searchKeydown(event: KeyboardEvent): void {
    if (composition.active) return event.stopPropagation();
    if (busy || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" && rows[0] !== undefined) {
      event.preventDefault();
      activate(rows.find((row) => row.node.kind === "file") ?? rows[0]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(event.key === "ArrowDown" ? 0 : rows.length - 1);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    }
  }
  /** 焦点浏览不打开文件；确认仍交由按钮的原生 Enter / Space 行为。 */
  function rowKeydown(event: KeyboardEvent, row: FileTreeRow): void {
    if (composition.active) return event.stopPropagation();
    if (busy || hidden) return;
    if (
      !event.altKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      ((!event.metaKey && event.key === "Delete") || (event.metaKey && event.key === "Backspace"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) requestTrash(row);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      searchInput.focus();
      return;
    }
    const index = rows.findIndex((item) => item.node.path === row.node.path);
    if (event.key === "ArrowRight" && row.node.kind === "directory") {
      event.preventDefault();
      if (!expanded.has(row.node.path) && !searching) toggle(row.node.path);
      else if (row.node.children.length > 0) focusRow(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.kind === "directory" && expanded.has(row.node.path) && !searching)
        toggle(row.node.path);
      else if (row.parent !== null)
        focusRow(rows.findIndex((item) => item.node.path === row.parent));
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, rows.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
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
        placeholder="查找文件…"
        bind:this={searchInput}
        bind:value={query}
        onkeydown={searchKeydown}
        oninput={() => (searchPosition = null)}
      />
      {#if query !== ""}
        <button class="clear-search" type="button" aria-label="清除快速查找" onclick={clearSearch}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
        </button>
      {/if}
    </div>
    <p class="caption" title={workspace.vaultRoot ?? undefined}>
      {rootName}<span>{searching ? "查找结果" : "文件目录"}</span>
    </p>
    <FileTreeViewport
      bind:this={viewport}
      {rows}
      {focusable}
      dragging={null}
      position={searching ? searchPosition : position}
      onPosition={(value) => {
        if (searching) searchPosition = value;
        else position = value;
      }}
      onEmptyFocus={() => searchInput.focus()}
      label="当前笔记库文件树"
      multiselectable={false}
    >
      {#snippet children(row: FileTreeRow)}
        {@const current = row.node.kind === "file" && row.node.path === active}
        <div class="file-row">
          <button
            class="file"
            class:active={current}
            type="button"
            role="treeitem"
            data-path={row.node.path}
            title={row.node.path}
            aria-label={row.node.name}
            aria-level={row.depth + 1}
            aria-posinset={row.position}
            aria-setsize={row.siblings}
            aria-expanded={row.node.kind === "directory"
              ? searching || expanded.has(row.node.path)
              : undefined}
            aria-current={current ? "page" : undefined}
            aria-selected={current}
            tabindex={row.node.path === focusable ? 0 : -1}
            style:padding-left="{0.4 + row.depth * 0.9}rem"
            disabled={busy}
            onfocus={() => (focused = row.node.path)}
            onkeydown={(event) => rowKeydown(event, row)}
            onclick={() => activate(row)}
          >
            <span class="chevron" class:expanded={searching || expanded.has(row.node.path)}>
              {#if row.node.kind === "directory"}<svg viewBox="0 0 16 16" aria-hidden="true"
                  ><path d="m6 4 4 4-4 4" /></svg
                >{/if}
            </span>
            <svg class="entry-icon" viewBox="0 0 20 20" aria-hidden="true">
              {#if row.node.kind === "directory"}<path
                  d="M2.5 5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9h-15z"
                />{:else}<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />{/if}
            </svg>
            <span class="name">{row.node.name}</span>
          </button>
          <button
            class="trash-file"
            type="button"
            tabindex="-1"
            aria-label={`将 ${row.node.path} 移到废纸篓`}
            title="移到废纸篓"
            disabled={busy}
            onfocus={() => (focused = row.node.path)}
            onclick={() => requestTrash(row)}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><path d="M3 5.5h14M7 5.5V3h6v2.5M5 5.5l1 12h8l1-12M8 8.5v6m4-6v6" /></svg
            ></button
          >
        </div>
      {/snippet}
    </FileTreeViewport>
    {#if rows.length === 0}
      <div class="empty" role="status">
        {#if searching}
          <strong>没有匹配的文件或文件夹</strong>
          <span>试试其他名称，或到资料管理搜索正文。</span>
        {:else}
          <span
            >{workspace.vaultRoot === null
              ? "开始记录，或打开已有资料。"
              : "当前笔记库为空，新建一篇笔记开始记录。"}</span
          >
        {/if}
      </div>
    {/if}
  </nav>
</Sidebar>

<style>
  .quick-navigation {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    padding: 1.25rem 0.75rem;
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
    font-weight: 500;
    margin: 1.25rem 0.5rem 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-row {
    position: relative;
    height: 100%;
  }
  .file {
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    width: 100%;
    text-align: left;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    padding: 0 2rem 0 0.4rem;
    border-radius: var(--radius-control);
    cursor: pointer;
    transition:
      background var(--motion-fast),
      color var(--motion-fast);
  }
  .trash-file {
    position: absolute;
    right: 0.2rem;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    border: 0;
    border-radius: 0.3rem;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
  }
  .file-row:hover .trash-file,
  .file-row:focus-within .trash-file {
    opacity: 1;
  }
  .trash-file:hover:not(:disabled),
  .trash-file:focus-visible {
    color: var(--danger);
    background: var(--selected);
  }
  .trash-file svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
  }
  @media (hover: none) {
    .trash-file {
      opacity: 1;
    }
  }
  .name {
    min-width: 0;
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
    color: var(--accent);
    font-weight: 500;
    box-shadow: 0 1px 4px var(--shadow);
  }
  .search :global(.reader-input) {
    background: color-mix(in srgb, var(--surface) 50%, transparent);
    border-color: color-mix(in srgb, var(--border) 65%, transparent);
  }
  .search :global(.reader-input:focus-visible) {
    border-color: var(--accent);
    background: var(--surface);
  }
  .caption span {
    display: block;
    font-size: 0.68rem;
    margin-top: 0.3rem;
  }
  .chevron {
    display: flex;
    width: 0.75rem;
    flex-shrink: 0;
  }
  .chevron svg,
  .entry-icon {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    flex-shrink: 0;
    color: var(--muted);
  }
  .chevron.expanded svg {
    transform: rotate(90deg);
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
</style>
