<script lang="ts">
  import { tick, untrack } from "svelte";
  import Sidebar from "./Sidebar.svelte";
  import FileTreeViewport from "./FileTreeViewport.svelte";
  import SearchResults from "./SearchResults.svelte";
  import TagBrowser from "./TagBrowser.svelte";
  import BookmarksPane from "./BookmarksPane.svelte";
  import type { EntryDialogAction } from "./FileEntryDialog.svelte";
  import FileMenu, { type FileMenuAction } from "./FileMenu.svelte";
  import type { Bookmark, SearchHit, VaultEntry } from "../../../shared/api";
  import type { ReaderWorkspaceController } from "../../state/workspace.svelte";
  import { isCompositionKey } from "../../engine/editing/composition";
  import { matchNeedle } from "../../engine/search/query";
  import {
    ancestorDirectories,
    buildFileTree,
    filterFileTree,
    findFileTreeNode,
    parentDirectory,
    visibleFileRows,
    type FileEntryChange,
    type FileTreeRow,
  } from "../../engine/navigation/file-tree";

  let {
    workspace,
    width,
    onWidth,
    onEdit,
    onOpen,
    hidden = false,
  }: {
    workspace: ReaderWorkspaceController;
    width: number;
    onWidth: (width: number) => void;
    onEdit: (action: EntryDialogAction, entry: VaultEntry | null, parent: string) => void;
    onOpen: () => void;
    hidden?: boolean;
  } = $props();
  let query = $state("");
  let expanded = $state.raw<ReadonlySet<string>>(new Set());
  let selected = $state<string | null>(null);
  let focused = $state<string | null>(null);
  // 结果模式下文件树被卸载，引用可能为空；调用处统一可选链。
  let treeViewport: FileTreeViewport | undefined = $state();
  let searchResults: SearchResults | undefined = $state();
  let recoveryElement: HTMLElement | undefined = $state();
  let searchInput: HTMLInputElement;
  let menu: FileMenu;
  let bookmarksPane: BookmarksPane | undefined = $state();
  const search = $derived(workspace.search);
  /** 侧栏主体：文件树、标签浏览或书签；检索结果优先于三者。 */
  let paneMode = $state<"files" | "tags" | "bookmarks">("files");
  const searchBookmark = $derived({ kind: "search" as const, query: query.trim(), title: null });
  let dragging = $state<VaultEntry | null>(null);
  let dropTarget = $state<string | null>(null);
  let previousRoot: string | null | undefined;
  const tree = $derived(buildFileTree(workspace.entries.filter((entry) => !entry.recoveryOnly)));
  const recoveries = $derived(
    workspace.entries.filter(
      (entry) =>
        entry.recoveryOnly &&
        entry.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const searching = $derived(query.trim() !== "");
  const rows = $derived(visibleFileRows(filterFileTree(tree, query), expanded, searching));
  const active = $derived(workspace.document.path);
  const activeRecovery = $derived(
    workspace.entries.some((entry) => entry.recoveryOnly && entry.path === active),
  );
  const busy = $derived(workspace.switching || workspace.copying);
  const focusable = $derived(
    rows.some((row) => row.node.path === focused)
      ? focused
      : rows.some((row) => row.node.kind === "file" && row.node.path === active)
        ? active
        : (rows[0]?.node.path ?? null),
  );

  $effect(() => {
    const path = active;
    const recovering = activeRecovery;
    const root = workspace.vaultRoot;
    untrack(() => {
      if (root !== previousRoot) {
        expanded = new Set();
        query = "";
        selected = null;
        paneMode = "files";
        previousRoot = root;
      }
      expanded = new Set([...expanded, ...ancestorDirectories(path)]);
      if (path !== null) {
        selected = recovering ? null : path;
        focused = selected;
      }
    });
  });

  function toggle(path: string): void {
    expanded = expanded.has(path)
      ? new Set([...expanded].filter((item) => item !== path))
      : new Set([...expanded, path]);
  }
  async function focusPath(path: string): Promise<void> {
    focused = path;
    await tick();
    await treeViewport?.focusPath(path);
  }
  async function activate(entry: VaultEntry): Promise<void> {
    selected = entry.recoveryOnly ? null : entry.path;
    focused = selected;
    if (entry.kind === "directory") toggle(entry.path);
    else {
      await workspace.openFile(entry.path);
      if (workspace.document.path === entry.path) onOpen();
    }
  }
  async function locate(): Promise<void> {
    if (active === null) return;
    query = "";
    if (activeRecovery) {
      await focusRecovery(active);
      return;
    }
    selected = active;
    expanded = new Set([...expanded, ...ancestorDirectories(active)]);
    await focusPath(active);
  }
  async function focusRecovery(path: string): Promise<void> {
    await tick();
    Array.from(recoveryElement?.querySelectorAll<HTMLButtonElement>("[data-path]") ?? [])
      .find((element) => element.dataset.path === path)
      ?.focus();
  }
  function entryBookmark(entry: VaultEntry): Bookmark {
    return { kind: entry.kind === "directory" ? "folder" : "file", path: entry.path, title: null };
  }
  function action(kind: FileMenuAction, entry: VaultEntry | null): void {
    if (kind === "bookmark") {
      if (entry !== null) void workspace.bookmarks.toggle(entryBookmark(entry));
      return;
    }
    if (kind === "collapse") {
      expanded = new Set();
      return;
    }
    if (kind === "locate") {
      void locate();
      return;
    }
    if (busy || workspace.vaultRoot === null) return;
    if (kind === "reveal") {
      if (entry) void workspace.revealEntry(entry.path);
      return;
    }
    const parent =
      entry === null
        ? ""
        : entry.kind === "directory" && (kind === "file" || kind === "directory")
          ? entry.path
          : parentDirectory(entry.path);
    onEdit(kind, entry, parent);
  }
  function currentEntry(): VaultEntry | null {
    return findFileTreeNode(tree, selected);
  }
  /** 从工具栏、空白状态和快捷键进入同一个新建流程，使用当前选中项所在目录。 */
  export function beginCreate(kind: "file" | "directory"): void {
    action(kind, currentEntry());
  }
  /** 聚焦文件搜索并选中现有查询；调用方须先展开文件栏。 */
  export function focusSearch(): void {
    searchInput.focus();
    searchInput.select();
  }
  /**
   * 已提交的操作统一跟随新路径，目录移动时保留内部展开状态。
   * @param change 已完成的文件变化；失败或门禁拒绝不得调用。
   * @param focus 文件栏可见且无需直接写作时，将键盘焦点交还目录。
   */
  export async function reflectChange(change: FileEntryChange, focus: boolean): Promise<void> {
    // 等待活动文档的更新完成，避免它的自动定位覆盖用户刚整理的条目。
    await tick();
    const from =
      change.action === "relocate"
        ? change.from
        : change.action === "trash"
          ? change.entry.path
          : null;
    if (from !== null) {
      expanded = new Set(
        [...expanded].flatMap((path) => {
          if (path !== from && !path.startsWith(`${from}/`)) return [path];
          return change.action === "relocate" ? [change.entry.path + path.slice(from.length)] : [];
        }),
      );
    }
    const path = change.action === "trash" ? parentDirectory(change.entry.path) : change.entry.path;
    query = "";
    expanded = new Set([...expanded, ...ancestorDirectories(path)]);
    const next =
      rows.find((row) => row.node.path === path)?.node.path ?? rows[0]?.node.path ?? null;
    selected = next;
    focused = next;
    if (!focus) return;
    if (next === null) searchInput.focus();
    else await focusPath(next);
  }
  /** 清除按钮：退出结果模式并清空过滤词，回到完整文件树。 */
  function clearSearch(): void {
    if (workspace.isComposing) return;
    search.reset();
    query = "";
    treeViewport?.resetScroll();
    searchInput.focus();
  }
  /** Escape：先退出结果模式（保留查询词供文件树过滤），再清空过滤词。 */
  function escapeSearch(): void {
    if (workspace.isComposing) return;
    if (search.active) {
      search.reset();
      searchInput.focus();
      return;
    }
    clearSearch();
  }
  /**
   * 回车提交全文检索；检索完成后键盘进入结果列表。
   *
   * 活动栏正在切换时不提交：文件栏的检索和打开要等这栏的门禁结束。
   * 另一栏的编辑不走这条锁。
   */
  async function submitSearch(): Promise<void> {
    if (busy) return;
    await search.run(query);
    if (!search.active) return;
    await tick();
    searchResults?.focusFirst();
  }
  /** 选中标签：转成 `tag:` 谓词检索，主体让位给结果列表。 */
  function pickTag(tag: string): void {
    paneMode = "files";
    query = `tag:${tag}`;
    void submitSearch();
  }
  /** 切到书签并把键盘焦点交给第一条；检索结果优先显示，所以先退出结果模式。 */
  export async function showBookmarks(): Promise<void> {
    search.reset();
    paneMode = "bookmarks";
    await tick();
    bookmarksPane?.focusFirst();
  }
  /** 文件与标题在活动栏打开；文件夹回到文件树展开定位；搜索重新执行。 */
  async function openBookmark(bookmark: Bookmark): Promise<void> {
    if (bookmark.kind === "search") {
      paneMode = "files";
      query = bookmark.query;
      await submitSearch();
    } else if (bookmark.kind === "folder") {
      paneMode = "files";
      query = "";
      selected = bookmark.path;
      expanded = new Set([...expanded, ...ancestorDirectories(bookmark.path), bookmark.path]);
      await focusPath(bookmark.path);
    } else {
      await workspace.openBookmark(bookmark);
      if (workspace.document.path === bookmark.path) onOpen();
    }
  }
  function searchKeydown(event: KeyboardEvent): void {
    if (busy || isCompositionKey(event) || workspace.isComposing) return;
    if (event.key === "Escape" && (search.active || query !== "")) {
      event.preventDefault();
      event.stopPropagation();
      escapeSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void submitSearch();
    } else if (event.key === "ArrowDown" && (search.active || recoveries[0] || rows[0])) {
      event.preventDefault();
      if (search.active) searchResults?.focusFirst();
      else if (recoveries[0]) void focusRecovery(recoveries[0].path);
      else if (rows[0]) void focusPath(rows[0].node.path);
    }
  }
  /** 打开命中文件并定位命中词；门禁阻止切换时保持当前文档。 */
  async function openHit(hit: SearchHit): Promise<void> {
    const submitted = search.query;
    if (submitted === null) return;
    const needle = matchNeedle(hit, submitted);
    await workspace.navigation.openTextMatch(hit.path, needle, workspace.openFile);
    if (workspace.document.path === hit.path) onOpen();
  }
  function context(event: MouseEvent, entry: VaultEntry): void {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    selected = entry.path;
    focused = entry.path;
    void menu.open(entry, event.clientX, event.clientY);
  }
  function keydown(event: KeyboardEvent, row: FileTreeRow): void {
    const index = rows.findIndex((item) => item.node.path === row.node.path);
    let next: string | undefined;
    if (event.key === "ArrowDown") next = rows[Math.min(index + 1, rows.length - 1)]?.node.path;
    else if (event.key === "ArrowUp") next = rows[Math.max(index - 1, 0)]?.node.path;
    else if (event.key === "Home") next = rows[0]?.node.path;
    else if (event.key === "End") next = rows.at(-1)?.node.path;
    else if (event.key === "ArrowRight" && row.node.kind === "directory") {
      if (!expanded.has(row.node.path) && !searching) toggle(row.node.path);
      else next = row.node.children[0]?.path;
    } else if (event.key === "ArrowLeft") {
      if (row.node.kind === "directory" && expanded.has(row.node.path) && !searching)
        toggle(row.node.path);
      else next = row.parent ?? undefined;
    } else if (event.key === "F2") action("rename", row.node);
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const rect =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.getBoundingClientRect()
          : null;
      if (rect) void menu.open(row.node, rect.left + 20, rect.bottom);
    } else return;
    event.preventDefault();
    if (next !== undefined) void focusPath(next);
  }
  function allowDrop(event: DragEvent, directory: string): void {
    if (
      busy ||
      dragging === null ||
      dragging.path === directory ||
      directory.startsWith(`${dragging.path}/`)
    )
      return;
    event.preventDefault();
    dropTarget = directory;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }
  async function drop(event: DragEvent, directory: string): Promise<void> {
    event.preventDefault();
    const entry = dragging;
    dragging = null;
    dropTarget = null;
    if (
      entry === null ||
      busy ||
      entry.path === directory ||
      directory.startsWith(`${entry.path}/`)
    )
      return;
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const to = directory === "" ? name : `${directory}/${name}`;
    const error = await workspace.renameEntry(entry.path, to);
    if (error !== null) workspace.report(error);
    else
      await reflectChange(
        { action: "relocate", from: entry.path, entry: { ...entry, path: to } },
        true,
      );
  }
</script>

<Sidebar {width} {onWidth} {hidden}>
  <nav class="list" aria-label="文件列表">
    <div class="pane-head">
      <button
        type="button"
        class="root-label"
        class:drop-target={dropTarget === ""}
        title="笔记库根目录；可将条目拖到这里"
        onclick={() => {
          selected = null;
        }}
        ondragover={(event) => allowDrop(event, "")}
        ondrop={(event) => void drop(event, "")}>笔记</button
      >
      <div class="tools">
        <button
          type="button"
          aria-label="浏览标签"
          aria-pressed={paneMode === "tags"}
          title="浏览标签"
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => {
            paneMode = paneMode === "tags" ? "files" : "tags";
            treeViewport?.resetScroll();
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M8 3 6.5 17M14 3l-1.5 14M4 7.5h12M3.5 12.5h12" /></svg
          ></button
        >
        <button
          type="button"
          aria-label="书签"
          aria-pressed={paneMode === "bookmarks"}
          title="书签"
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => {
            paneMode = paneMode === "bookmarks" ? "files" : "bookmarks";
            treeViewport?.resetScroll();
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M5.5 3h9v14l-4.5-3.5L5.5 17z" /></svg
          ></button
        >
        <button
          type="button"
          aria-label="新建笔记"
          aria-keyshortcuts="Meta+N Control+N"
          title="新建笔记（⌘N / Ctrl+N）"
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => action("file", currentEntry())}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button
        >
        <button
          type="button"
          aria-label="文件管理"
          title="文件管理"
          disabled={busy || workspace.vaultRoot === null}
          onclick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void menu.open(null, box.left, box.bottom + 4);
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle
              cx="16"
              cy="10"
              r="1"
            /></svg
          ></button
        >
      </div>
    </div>
    <div class="search">
      <svg viewBox="0 0 20 20" aria-hidden="true"
        ><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg
      ><input
        type="text"
        role="searchbox"
        aria-label="搜索文件和全文"
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
        placeholder="搜索文件，回车搜全文"
        title="输入即过滤文件；回车全文搜索，支持 OR、-排除、(分组)、&quot;短语&quot;、/正则/、tag:标签、path:路径、file:文件名、[属性]、[属性:值]、line:( )、section:( )"
        disabled={busy}
        bind:this={searchInput}
        bind:value={query}
        oninput={() => treeViewport?.resetScroll()}
        onkeydown={searchKeydown}
      />
      {#if search.active && searchBookmark.query !== ""}
        {@const saved = workspace.bookmarks.has(searchBookmark)}
        <button
          type="button"
          class="save-search"
          class:saved
          aria-label={saved ? "取消收藏此搜索" : "收藏此搜索"}
          aria-pressed={saved}
          title={saved ? "取消收藏此搜索" : "收藏此搜索"}
          disabled={busy}
          onclick={() => void workspace.bookmarks.toggle(searchBookmark)}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M5.5 3h9v14l-4.5-3.5L5.5 17z" /></svg
          ></button
        >
      {/if}
      {#if query !== "" || search.active}
        <button
          type="button"
          class="clear-search"
          aria-label="清除搜索"
          title="清除搜索（Esc）"
          disabled={busy}
          onclick={clearSearch}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button
        >
      {/if}
    </div>
    {#if search.active}
      <SearchResults
        bind:this={searchResults}
        {search}
        activePath={active}
        onActivate={(hit) => void openHit(hit)}
        onExit={escapeSearch}
      />
    {:else if paneMode === "tags"}
      <TagBrowser {workspace} onPick={pickTag} />
    {:else if paneMode === "bookmarks"}
      <BookmarksPane
        bind:this={bookmarksPane}
        {workspace}
        {busy}
        onActivate={(bookmark) => void openBookmark(bookmark)}
      />
    {:else}
      {#if recoveries.length > 0}
        <section class="recovery" aria-label="待恢复的笔记" bind:this={recoveryElement}>
          <h2>待恢复的笔记</h2>
          <p>原路径发生变化。打开笔记后，可另存副本。</p>
          {#each recoveries as entry (entry.path)}
            <button
              type="button"
              class="recovery-entry"
              class:active={entry.path === active}
              data-path={entry.path}
              aria-current={entry.path === active ? "page" : undefined}
              title={entry.path}
              disabled={busy}
              onclick={() => void activate(entry)}
            >
              <span class="name">{entry.path.split("/").at(-1)}</span>
              <span class="recovery-path">{entry.path}</span>
            </button>
          {/each}
        </section>
      {/if}
      <FileTreeViewport
        bind:this={treeViewport}
        {rows}
        {focusable}
        dragging={dragging?.path ?? null}
      >
        {#snippet children(row)}
          <button
            type="button"
            role="treeitem"
            class="file"
            class:folder={row.node.kind === "directory"}
            class:active={row.node.kind === "file" && row.node.path === active}
            class:dragging={dragging?.path === row.node.path}
            class:drop-target={dropTarget === row.node.path}
            data-path={row.node.path}
            style:--depth={row.depth}
            tabindex={focusable === row.node.path ? 0 : -1}
            aria-level={row.depth + 1}
            aria-posinset={row.position}
            aria-setsize={row.siblings}
            aria-selected={selected === row.node.path}
            aria-current={row.node.kind === "file" && row.node.path === active ? "page" : undefined}
            aria-expanded={row.node.kind === "directory"
              ? searching || expanded.has(row.node.path)
              : undefined}
            title={row.node.path}
            disabled={busy}
            draggable={!busy}
            onfocus={() => {
              focused = row.node.path;
              selected = row.node.path;
            }}
            onclick={() => void activate(row.node)}
            onkeydown={(event) => keydown(event, row)}
            oncontextmenu={(event) => context(event, row.node)}
            ondragstart={(event) => {
              dragging = { path: row.node.path, kind: row.node.kind };
              event.dataTransfer?.setData("text/plain", row.node.path);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            }}
            ondragend={() => {
              dragging = null;
              dropTarget = null;
            }}
            ondragover={(event) => {
              if (row.node.kind === "directory") allowDrop(event, row.node.path);
            }}
            ondragleave={() => {
              dropTarget = null;
            }}
            ondrop={(event) => {
              if (row.node.kind === "directory") void drop(event, row.node.path);
            }}
          >
            <span class="chevron" class:expanded={searching || expanded.has(row.node.path)}
              >{#if row.node.kind === "directory"}<svg viewBox="0 0 16 16" aria-hidden="true"
                  ><path d="m6 4 4 4-4 4" /></svg
                >{/if}</span
            >
            <svg class="entry-icon" viewBox="0 0 20 20" aria-hidden="true"
              >{#if row.node.kind === "directory"}<path
                  d="M2.5 5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9h-15z"
                />{:else}<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />{/if}</svg
            >
            <span class="name">{row.node.name}</span>
            {#if row.node.kind === "file" && row.node.path === active}<span
                class="current-dot"
                aria-hidden="true"
                title="正在阅读"
              ></span>{/if}
          </button>
        {/snippet}
      </FileTreeViewport>
      {#if rows.length === 0 && recoveries.length === 0}
        <div class="empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6l2 2h8v13H4z" /></svg>
          <strong>{searching ? "没有匹配的文件" : "这里还很安静"}</strong>
          <p>
            {searching
              ? "试试其他关键词，或查看全部文件。"
              : workspace.vaultRoot === null
                ? "打开笔记库，让想法有个归处。"
                : "写下第一篇笔记，从这里开始。"}
          </p>
          {#if searching}
            <button type="button" class="empty-action" onclick={clearSearch}>查看全部文件</button>
          {:else if workspace.vaultRoot !== null}
            <button
              type="button"
              class="empty-action"
              disabled={busy}
              onclick={() => beginCreate("file")}>新建笔记</button
            >
          {/if}
        </div>
      {/if}
    {/if}
  </nav>
</Sidebar>
<FileMenu
  bind:this={menu}
  onAction={action}
  bookmarked={(entry) => workspace.bookmarks.has(entryBookmark(entry))}
/>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--sidebar);
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 0.8rem 0.35rem;
  }
  .root-label {
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.3rem;
  }
  button {
    font: inherit;
    color: inherit;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 0.4rem;
  }
  .tools {
    display: flex;
    gap: 0.15rem;
  }
  .tools button {
    padding: 0.35rem;
    display: flex;
  }
  svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  button:hover:not(:disabled) {
    background: var(--selected);
  }
  .tools button[aria-pressed="true"] {
    background: var(--selected);
    color: var(--accent);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.1rem 0.8rem 0.65rem;
    padding: 0.3rem 0.5rem;
    color: var(--muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.55rem;
  }
  input {
    width: 100%;
    min-width: 0;
    color: var(--fg);
    background: transparent;
    border: none;
    font: inherit;
    font-size: 0.8rem;
    outline: none;
  }
  .clear-search,
  .save-search {
    display: flex;
    padding: 0;
    color: var(--muted);
    flex-shrink: 0;
  }
  .save-search.saved {
    color: var(--accent);
  }
  .save-search.saved svg {
    fill: currentColor;
  }
  .search:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .recovery {
    flex: 0 1 auto;
    max-height: 40%;
    overflow: auto;
    margin: 0 0.55rem 0.65rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .recovery h2 {
    color: var(--warning);
    font-size: 0.75rem;
    font-weight: 600;
    margin: 0.3rem 0.5rem;
  }
  .recovery p {
    color: var(--muted);
    font-size: 0.75rem;
    margin: 0.3rem 0.5rem 0.55rem;
    line-height: 1.5;
  }
  .recovery-entry {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 0.2rem;
    padding: 0.5rem;
    text-align: left;
    align-items: stretch;
    font-size: 0.85rem;
  }
  .recovery-entry.active {
    background: var(--selected);
  }
  .recovery-path {
    font-size: 0.7rem;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    text-align: left;
    height: calc(var(--file-row-height) - 0.1rem);
    padding: 0.3rem 0.5rem 0.3rem calc(0.25rem + var(--depth) * 1rem);
    font-size: 0.85rem;
    margin-bottom: 0.1rem;
  }
  .chevron {
    flex: 0 0 0.75rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
  }
  .chevron svg {
    width: 0.75rem;
    height: 0.75rem;
    transition: transform 0.12s;
  }
  .chevron.expanded svg {
    transform: rotate(90deg);
  }
  .entry-icon {
    color: var(--muted);
    width: 1rem;
    height: 1rem;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }
  .file[aria-selected="true"] {
    background: var(--selected);
  }
  .file.active {
    font-weight: 500;
  }
  .folder .entry-icon,
  .file.active .entry-icon {
    color: var(--accent);
  }
  :global(.list-body:focus-within) .file[aria-selected="true"] {
    background: color-mix(in srgb, var(--accent) 14%, var(--sidebar));
  }
  .file:focus-visible {
    outline-offset: -2px;
  }
  .current-dot {
    width: 0.3rem;
    height: 0.3rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent);
  }
  .file.dragging {
    opacity: 0.45;
  }
  .drop-target {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: var(--selected);
  }
  .empty {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 2.5rem 1.2rem;
    display: flex;
    align-items: center;
    flex-direction: column;
    gap: 0.65rem;
    text-align: center;
  }
  .empty > svg {
    width: 2rem;
    height: 2rem;
    stroke-width: 1.1;
    opacity: 0.6;
    margin-bottom: 0.2rem;
  }
  .empty strong {
    font-weight: 500;
    color: var(--fg);
  }
  .empty p {
    margin: 0;
    max-width: 12rem;
  }
  .empty-action {
    color: var(--accent);
    padding: 0.35rem 0.65rem;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron svg {
      transition: none;
    }
  }
</style>
