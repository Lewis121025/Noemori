<script lang="ts">
  import { revealOnChange } from "../motion";
  import { tick, untrack } from "svelte";
  import LibraryFrame from "./LibraryFrame.svelte";
  import { libraryCreationDirectory, libraryEntryKind } from "./library";
  import FileGridViewport from "./FileGridViewport.svelte";
  import { fileGridRows } from "./file-grid";
  import InlineRename from "./InlineRename.svelte";
  import FileBatchDialog from "./FileBatchDialog.svelte";
  import { selectFileRows } from "./file-selection";
  import type { FileTreePosition } from "../../shared/file-browser";
  import type { EntryBatchResult } from "../../shared/entry-batch";
  import TagBrowser from "../tags/TagBrowser.svelte";
  import BookmarksPane from "../bookmarks/BookmarksPane.svelte";
  import type { EntryDialogAction } from "./FileEntryDialog.svelte";
  import FileMenu, { type FileMenuAction } from "./FileMenu.svelte";
  import type { Bookmark, VaultEntry } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { isCompositionKey } from "../../shared/composition";
  import {
    buildFileTree,
    findFileTreeNode,
    parentDirectory,
    type FileEntryChange,
    type FileTreeRow,
  } from "./file-tree";

  let {
    workspace,
    readFile,
    onEdit,
    onOpen,
    hidden = false,
    onSearch = () => {},
    onNewWhiteboard,
  }: {
    workspace: ReaderWorkspaceController;
    readFile: (path: string) => Promise<Uint8Array>;
    onEdit: (action: EntryDialogAction, entry: VaultEntry | null, parent: string) => void;
    onOpen: () => void;
    hidden?: boolean;
    onSearch?: (query: string) => void;
    onNewWhiteboard?: (parent: string) => void;
  } = $props();
  let previewOpen = $state(false);
  const browser = $derived(workspace.fileTree);
  const browse = $derived(browser.state.browse);
  const query = $derived(browse?.query ?? "");
  const currentDirectory = $derived(browse?.directory ?? "");
  const selectedPaths = $derived(browser.state.selected);
  const selected = $derived(new Set(selectedPaths));
  const focused = $derived(browser.state.focused);
  let selectionAnchor = $state<string | null>(null);
  let filteredScroll = $state.raw<FileTreePosition | null>(null);
  let renaming = $state.raw<VaultEntry | null>(null);
  let renameIssue = $state("");
  const renameErrorId = $props.id();
  // 标签与书签会卸载网格，异步焦点交接必须允许视口已经消失。
  let gridViewport: FileGridViewport | undefined = $state();
  let recoveryElement: HTMLElement | undefined = $state();
  let searchInput: HTMLInputElement;
  let menu: FileMenu;
  let batchDialog: FileBatchDialog;
  let draggedEntries = $state.raw<VaultEntry[]>([]);
  let batchFallback: string | null = null;
  let bookmarksPane: BookmarksPane | undefined = $state();
  /** 资料管理主体；查询与分类随目录现场恢复，结果按当前索引重建。 */
  const paneMode = $derived(browser.state.browse?.section ?? "files");
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
  const rows = $derived(fileGridRows(tree, currentDirectory, query));
  const selectedEntries = $derived(
    rows
      .filter((row) => selected.has(row.node.path))
      .map((row) => ({ path: row.node.path, kind: row.node.kind })),
  );
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
    if (!browser.ready || busy) return;
    untrack(() => {
      const initial = root !== previousRoot;
      if (initial) {
        filteredScroll = null;
        renaming = null;
        renameIssue = "";
        selectionAnchor = browser.state.focused;
        previousRoot = root;
      }
      if (initial && !browser.hasStoredState) {
        browser.update({
          browse: {
            query: "",
            section: "files",
            directory: path === null || recovering ? "" : parentDirectory(path),
          },
        });
        if (path !== null) selectOnly(recovering ? null : path);
      }
    });
  });

  $effect(() => {
    const visible = new Set(rows.map((row) => row.node.path));
    if (!browser.ready || busy) return;
    untrack(() => {
      const retained = browser.state.selected.filter((path) => visible.has(path));
      if (retained.length !== browser.state.selected.length) browser.update({ selected: retained });
    });
  });

  function selectOnly(path: string | null): void {
    browser.update({ selected: path === null ? [] : [path], focused: path });
    selectionAnchor = path;
  }
  function selectRow(path: string, mode: "replace" | "toggle" | "range" | "extend"): void {
    const next = selectFileRows(
      { paths: selected, anchor: selectionAnchor },
      rows.map((row) => row.node.path),
      path,
      mode,
    );
    browser.update({ selected: [...next.paths], focused: path });
    selectionAnchor = next.anchor;
  }
  /**
   * 用户从侧栏、网格或面包屑切换目录时结束临时编辑；文件改名的路径映射不调用此入口。
   * @param path 已存在的库内目录，空字符串表示库根。
   * @returns 不返回值；目录持久化失败由工作区统一报告。
   */
  export function enterDirectory(path: string): void {
    previewOpen = false;
    filteredScroll = null;
    renaming = null;
    renameIssue = "";
    selectionAnchor = null;
    browser.enterDirectory(path);
  }
  /** 查询、分类与目录一次提交到会话，避免视图切换后恢复过时的浏览位置。 */
  function showPane(mode: typeof paneMode, text = ""): void {
    previewOpen = false;
    if (browser.ready)
      browser.update({ browse: { query: text, section: mode, directory: currentDirectory } });
  }
  async function focusPath(path: string, select = true): Promise<void> {
    previewOpen = false;
    if (select) selectOnly(path);
    else browser.update({ focused: path });
    await tick();
    await gridViewport?.focusPath(path);
  }
  /** 关闭窄窗口预览后使原焦点条目可见并接续键盘操作，保留选择与查询。 */
  async function closePreview(): Promise<void> {
    previewOpen = false;
    await tick();
    if (hidden) return;
    if (focusable !== null) await gridViewport?.focusPath(focusable);
    else searchInput.focus();
  }
  async function activate(entry: VaultEntry): Promise<void> {
    selectOnly(entry.recoveryOnly ? null : entry.path);
    if (entry.kind === "directory") enterDirectory(entry.path);
    else {
      await workspace.openFile(entry.path);
      if (workspace.document.path === entry.path) onOpen();
    }
  }
  async function locate(): Promise<void> {
    if (active === null) return;
    enterDirectory(parentDirectory(active));
    if (activeRecovery) {
      await focusRecovery(active);
      return;
    }
    selectOnly(active);
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
    if (kind === "locate") {
      void locate();
      return;
    }
    if (busy) return;
    if (kind === "file") {
      onEdit("file", entry, libraryCreationDirectory(entry, currentDirectory));
      return;
    }
    if (workspace.vaultRoot === null) return;
    if (kind === "export") {
      const paths = selected.size > 1 ? [...selected] : entry ? [entry.path] : [...selected];
      workspace.requestExport({ kind: "selection", paths });
      return;
    }
    if ((kind === "move" || kind === "trash") && selected.size > 1) {
      beginBatch(kind);
      return;
    }
    if (kind === "reveal") {
      if (entry) void workspace.revealEntry(entry.path);
      return;
    }
    if (kind === "rename") {
      if (entry !== null) void beginRename(entry);
      return;
    }
    const parent =
      kind === "directory"
        ? libraryCreationDirectory(entry, currentDirectory)
        : entry === null
          ? currentDirectory
          : parentDirectory(entry.path);
    onEdit(kind, entry, parent);
  }
  async function beginRename(entry: VaultEntry): Promise<void> {
    await focusPath(entry.path);
    selectOnly(entry.path);
    renaming = entry;
    renameIssue = "";
  }
  async function finishRename(
    entry: VaultEntry,
    destination: string | null,
    focus: boolean,
  ): Promise<void> {
    // 切库或退出本次编辑后，旧请求的收尾不能改变新目录的焦点。
    if (renaming !== entry) return;
    renaming = null;
    renameIssue = "";
    if (destination !== null)
      await reflectChange(
        { action: "relocate", from: entry.path, entry: { ...entry, path: destination } },
        focus && !hidden,
      );
    else if (focus && !hidden) await focusPath(entry.path);
  }
  function currentEntry(): VaultEntry | null {
    return selected.size === 1 ? findFileTreeNode(tree, [...selected][0] ?? null) : null;
  }
  function rememberBatchFallback(entries: VaultEntry[]): void {
    const affected = (path: string) =>
      entries.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
    const first = rows.findIndex((row) => affected(row.node.path));
    batchFallback =
      rows.slice(first).find((row) => !affected(row.node.path))?.node.path ??
      rows.slice(0, first).findLast((row) => !affected(row.node.path))?.node.path ??
      null;
  }
  function beginBatch(kind: "move" | "trash"): void {
    if (busy || selectedEntries.length === 0) return;
    rememberBatchFallback(selectedEntries);
    void batchDialog.open(kind, selectedEntries);
  }
  async function reflectBatch(result: EntryBatchResult): Promise<void> {
    await tick();
    showPane("files");
    const paths =
      result.remaining.length > 0
        ? result.remaining
        : [
            ...result.completed.flatMap((change) => (change.to === null ? [] : [change.to])),
            ...result.skipped,
          ];
    if (paths[0]) enterDirectory(parentDirectory(paths[0]));
    const available = new Set(rows.map((row) => row.node.path));
    const retained = paths.filter((path) => available.has(path));
    browser.update({
      selected: retained,
      focused:
        retained[0] ??
        (batchFallback !== null && available.has(batchFallback)
          ? batchFallback
          : (rows[0]?.node.path ?? null)),
    });
    selectionAnchor = browser.state.focused;
  }
  async function finishBatch(): Promise<void> {
    if (hidden) return;
    await tick();
    if (focusable !== null) await focusPath(focusable, false);
    else searchInput.focus();
  }
  /** 聚焦资料搜索并选中现有查询；调用方须先进入资料管理空间。 */
  export async function focusSearch(): Promise<void> {
    previewOpen = false;
    await tick();
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
    const path = change.action === "trash" ? parentDirectory(change.entry.path) : change.entry.path;
    showPane("files");
    enterDirectory(change.action === "trash" ? currentDirectory : parentDirectory(path));
    const next =
      rows.find((row) => row.node.path === path)?.node.path ?? rows[0]?.node.path ?? null;
    selectOnly(next);
    if (!focus) return;
    if (next === null) searchInput.focus();
    else await focusPath(next);
  }
  /** 清空路径查询，恢复当前文件夹的网格与滚动位置。 */
  function clearSearch(): void {
    if (workspace.isComposing) return;
    showPane("files");
    searchInput.focus();
  }
  /** 标签条件交给独立的全文搜索，保留文件管理的浏览位置。 */
  function pickTag(tag: string): void {
    onSearch(`tag:${tag}`);
  }
  /** 切到书签后把键盘焦点交给第一条，不改变浏览目录。 */
  export async function showBookmarks(): Promise<void> {
    showPane("bookmarks");
    await tick();
    bookmarksPane?.focusFirst();
  }
  /** 文件与标题在活动栏打开；文件夹进入对应目录；搜索交给全文搜索。 */
  async function openBookmark(bookmark: Bookmark): Promise<void> {
    if (bookmark.kind === "search") {
      onSearch(bookmark.query);
    } else if (bookmark.kind === "folder") {
      enterDirectory(bookmark.path);
    } else {
      await workspace.openBookmark(bookmark);
      if (workspace.document.path === bookmark.path) onOpen();
    }
  }
  function searchKeydown(event: KeyboardEvent): void {
    if (busy || isCompositionKey(event) || workspace.isComposing) return;
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    } else if (event.key === "ArrowDown" && rows[0]) {
      event.preventDefault();
      void focusPath(rows[0].node.path);
    }
  }
  function context(event: MouseEvent, entry: VaultEntry): void {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    if (!selected.has(entry.path)) selectOnly(entry.path);
    browser.update({ focused: entry.path });
    void menu.open(entry, event.clientX, event.clientY);
  }
  function keydown(event: KeyboardEvent, row: FileTreeRow): void {
    if (event.defaultPrevented || busy || isCompositionKey(event) || workspace.isComposing) return;
    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      void activate(row.node);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      browser.update({ selected: rows.map((item) => item.node.path) });
      selectionAnchor = row.node.path;
      return;
    }
    if (event.key === " " && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      selectRow(row.node.path, "toggle");
      return;
    }
    if (event.key === "Escape" && selected.size > 1) {
      event.preventDefault();
      event.stopPropagation();
      selectOnly(row.node.path);
      return;
    }
    if (
      !event.altKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      ((!event.metaKey && event.key === "Delete") || (event.metaKey && event.key === "Backspace"))
    ) {
      event.preventDefault();
      const entry = currentEntry();
      if (!event.repeat && (entry !== null || selected.size > 1)) action("trash", entry);
      return;
    }
    const navigation = ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(
      event.key,
    );
    if (
      event.altKey ||
      (!navigation && (event.metaKey || event.ctrlKey || (event.shiftKey && event.key !== "F10")))
    )
      return;
    if (event.key === "Escape" && searching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    const next = gridViewport?.nextPath(row.node.path, event.key) ?? undefined;
    if (next !== undefined) {
      if (event.shiftKey) selectRow(next, event.metaKey || event.ctrlKey ? "extend" : "range");
      else if (!event.metaKey && !event.ctrlKey) selectOnly(next);
      event.preventDefault();
      void focusPath(next, false);
      return;
    } else if (event.key === "F2") {
      const entry = currentEntry();
      if (entry !== null) action("rename", entry);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const rect =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.getBoundingClientRect()
          : null;
      if (!selected.has(row.node.path)) selectOnly(row.node.path);
      if (rect) void menu.open(row.node, rect.left + 20, rect.bottom);
    } else return;
    event.preventDefault();
  }
  function allowDrop(event: DragEvent, directory: string): void {
    if (
      busy ||
      dragging === null ||
      draggedEntries.some(
        (entry) => entry.path === directory || directory.startsWith(`${entry.path}/`),
      )
    )
      return;
    event.preventDefault();
    dropTarget = directory;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }
  async function drop(event: DragEvent, directory: string): Promise<void> {
    event.preventDefault();
    const entries = draggedEntries;
    dragging = null;
    draggedEntries = [];
    dropTarget = null;
    if (
      entries.length === 0 ||
      busy ||
      entries.some((entry) => entry.path === directory || directory.startsWith(`${entry.path}/`))
    )
      return;
    rememberBatchFallback(entries);
    await batchDialog.drop(entries, directory);
  }
</script>

{#snippet entryIcon(row: FileTreeRow)}
  <svg class="entry-icon" viewBox="0 0 20 20" aria-hidden="true"
    >{#if row.node.kind === "directory"}<path
        d="M2.5 5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9h-15z"
      />{:else}<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />{/if}</svg
  >
{/snippet}

<LibraryFrame
  {workspace}
  count={rows.length}
  {hidden}
  bind:previewOpen
  onClosePreview={() => void closePreview()}
  selected={selectedEntries}
  onAction={action}
  onOpen={(entry) => void activate(entry)}
  {readFile}
  {...onNewWhiteboard === undefined
    ? {}
    : {
        onNewWhiteboard: () =>
          onNewWhiteboard?.(libraryCreationDirectory(currentEntry(), currentDirectory)),
      }}
>
  <nav
    class="list"
    aria-label="文件列表"
    use:revealOnChange={{ key: workspace.fileTree.state.browse?.directory ?? "", kind: "panel" }}
  >
    <div class="pane-head">
      <button
        type="button"
        class="root-label"
        class:drop-target={dropTarget === ""}
        title="笔记库根目录；可将条目拖到这里"
        onclick={() => {
          enterDirectory("");
        }}
        ondragover={(event) => allowDrop(event, "")}
        ondrop={(event) => void drop(event, "")}>全部文件</button
      >
      <div class="breadcrumbs" aria-label="当前文件夹">
        {#each currentDirectory.split("/").filter(Boolean) as name, index (currentDirectory
          .split("/")
          .slice(0, index + 1)
          .join("/"))}
          <span aria-hidden="true">/</span>
          <button
            type="button"
            onclick={() =>
              enterDirectory(
                currentDirectory
                  .split("/")
                  .slice(0, index + 1)
                  .join("/"),
              )}>{name}</button
          >
        {/each}
      </div>
      <div class="tools">
        <button
          type="button"
          aria-label="浏览标签"
          aria-pressed={paneMode === "tags"}
          title="浏览标签"
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => {
            showPane(paneMode === "tags" ? "files" : "tags");
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M8 3 6.5 17M14 3l-1.5 14M4 7.5h12M3.5 12.5h12" /></svg
          >标签</button
        >
        <button
          type="button"
          aria-label="书签"
          aria-pressed={paneMode === "bookmarks"}
          title="书签"
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => {
            showPane(paneMode === "bookmarks" ? "files" : "bookmarks");
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M5.5 3h9v14l-4.5-3.5L5.5 17z" /></svg
          >收藏</button
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
        aria-label="筛选当前列表"
        placeholder="筛选文件名…"
        disabled={busy}
        bind:this={searchInput}
        value={query}
        oninput={(event) => {
          showPane("files", event.currentTarget.value);
          filteredScroll = null;
        }}
        onkeydown={searchKeydown}
      />
      {#if query !== ""}
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
    {#if paneMode === "tags"}
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
      <FileGridViewport
        bind:this={gridViewport}
        {rows}
        focused={focusable}
        {selected}
        dragging={dragging?.path ?? null}
        position={searching ? filteredScroll : browser.state.scroll}
        onPosition={(position) => {
          if (searching) filteredScroll = position;
          else browser.update({ scroll: position });
        }}
        onEmptyFocus={() => searchInput.focus()}
      >
        {#snippet children(row)}
          {#if renaming?.path === row.node.path}
            {@const entry = renaming}
            <div
              class="file file-card"
              class:folder={row.node.kind === "directory"}
              data-path={row.node.path}
              aria-label={row.node.name}
            >
              {@render entryIcon(row)}
              <InlineRename
                {entry}
                entries={workspace.entries}
                errorId={renameErrorId}
                onRename={(from, to) => workspace.renameEntry(from, to)}
                onIssue={(issue) => {
                  renameIssue = issue;
                }}
                onFinish={(destination, focus) => void finishRename(entry, destination, focus)}
              />
            </div>
          {:else}
            <button
              type="button"
              class="file file-card"
              class:folder={row.node.kind === "directory"}
              class:active={row.node.kind === "file" && row.node.path === active}
              class:selected={selected.has(row.node.path)}
              class:dragging={dragging?.path === row.node.path}
              class:drop-target={dropTarget === row.node.path}
              data-path={row.node.path}
              tabindex={focusable === row.node.path ? 0 : -1}
              aria-label={row.node.name}
              aria-keyshortcuts="F2 Delete Meta+Backspace"
              aria-current={row.node.kind === "file" && row.node.path === active
                ? "page"
                : undefined}
              title={row.node.path}
              disabled={busy}
              draggable={!busy}
              onfocus={() => {
                browser.update({ focused: row.node.path });
              }}
              onclick={(event) => {
                if (event.shiftKey)
                  selectRow(row.node.path, event.metaKey || event.ctrlKey ? "extend" : "range");
                else if (event.metaKey || event.ctrlKey) selectRow(row.node.path, "toggle");
                else selectOnly(row.node.path);
              }}
              ondblclick={() => {
                void activate(row.node);
              }}
              onkeydown={(event) => keydown(event, row)}
              oncontextmenu={(event) => context(event, row.node)}
              ondragstart={(event) => {
                if (!selected.has(row.node.path)) selectOnly(row.node.path);
                draggedEntries = selectedEntries;
                dragging = { path: row.node.path, kind: row.node.kind };
                event.dataTransfer?.setData(
                  "text/plain",
                  draggedEntries.map((entry) => entry.path).join("\n"),
                );
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              }}
              ondragend={() => {
                dragging = null;
                draggedEntries = [];
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
              {@render entryIcon(row)}
              <span class="name">{row.node.name}</span>
              <span class="entry-kind" title={searching ? row.node.path : undefined}
                >{searching
                  ? parentDirectory(row.node.path) || "根目录"
                  : libraryEntryKind(row.node)}</span
              >
              {#if row.node.kind === "file" && row.node.path === active}<span
                  class="current-dot"
                  aria-hidden="true"
                  title="正在阅读"
                ></span>{/if}
            </button>
          {/if}
        {/snippet}
      </FileGridViewport>
      {#if renameIssue}<p class="rename-error" id={renameErrorId} role="alert">
          {renameIssue}
        </p>{/if}
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
          {/if}
        </div>
      {/if}
    {/if}
  </nav>
</LibraryFrame>
<FileMenu
  bind:this={menu}
  onAction={action}
  selectionCount={selected.size}
  bookmarked={(entry) => workspace.bookmarks.has(entryBookmark(entry))}
/>
<FileBatchDialog
  bind:this={batchDialog}
  {workspace}
  onComplete={reflectBatch}
  onClose={() => void finishBatch()}
/>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--bg);
    min-width: 0;
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
    align-items: center;
    gap: 0.3rem;
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
    background: var(--sidebar);
    border: 1px solid transparent;
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
  .clear-search {
    display: flex;
    padding: 0;
    color: var(--muted);
    flex-shrink: 0;
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
  .file-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 136px;
    gap: 6px;
    padding: 10px 8px;
    border: 1px solid transparent;
    border-radius: 10px;
    text-align: center;
    position: relative;
  }
  .file-card:hover:not(:disabled) {
    background: var(--sidebar);
  }
  .file-card.selected {
    background: var(--selected);
    border-color: var(--accent);
  }
  .file-card.dragging {
    opacity: 0.45;
  }
  .drop-target {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: var(--selected);
  }
  .rename-error {
    margin: 0.4rem 0.8rem 0.65rem;
    color: var(--danger);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .file-card .entry-icon {
    width: 44px;
    height: 50px;
    color: var(--muted);
  }
  .file-card.folder .entry-icon {
    color: var(--accent);
  }
  .file-card .name {
    max-width: 100%;
    font-size: 0.8rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .file-card .entry-kind {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .current-dot {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .breadcrumbs {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 4px;
    overflow: auto;
    padding: 0 6px;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--muted);
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
</style>
