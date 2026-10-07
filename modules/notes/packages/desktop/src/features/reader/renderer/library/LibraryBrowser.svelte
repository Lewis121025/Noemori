<script lang="ts">
  import { tick, untrack } from "svelte";
  import LibraryFrame from "./LibraryFrame.svelte";
  import FileTreeViewport from "./FileTreeViewport.svelte";
  import { libraryTreeRows, libraryTitle } from "./library-tree";
  import HighlightedText from "./HighlightedText.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ArticleAgentActions } from "../../shared/article-conversations";
  import InlineRename from "./InlineRename.svelte";
  import FileBatchDialog from "./FileBatchDialog.svelte";
  import { selectFileRows } from "./file-selection";
  import {
    DEFAULT_FILE_PRESENTATION,
    type FileTreePosition,
    type FilePresentation,
  } from "../../shared/file-browser";
  import type { EntryBatchResult } from "../../shared/entry-batch";
  import TagBrowser from "../tags/TagBrowser.svelte";
  import BookmarksPane from "../bookmarks/BookmarksPane.svelte";
  import type { EntryDialogAction } from "./FileEntryDialog.svelte";
  import FileMenu, { type FileMenuAction } from "./FileMenu.svelte";
  import type { Bookmark, VaultEntry } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { isCompositionKey } from "../../shared/composition";
  import {
    ancestorDirectories,
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
    onOpenVault,
    articleAgent,
    articleCounts = {},
    onConversations,
  }: {
    workspace: ReaderWorkspaceController;
    readFile: (path: string) => Promise<Uint8Array>;
    onEdit: (
      action: EntryDialogAction | "file" | "directory",
      entry: VaultEntry | null,
      parent: string,
    ) => void;
    onOpen: () => void;
    hidden?: boolean;
    onSearch?: (query: string) => void;
    onNewWhiteboard?: (parent: string) => void;
    onOpenVault?: () => void;
    articleAgent?: ArticleAgentActions;
    articleCounts?: Record<string, number>;
    onConversations?: (path: string) => void;
  } = $props();
  let previewOpen = $state(false);
  let readingFocused = $state(false);
  let previewTab = $state<"article" | "chat">("article");
  const browser = $derived(workspace.fileTree);
  const presentation = $derived(browser.state.presentation ?? DEFAULT_FILE_PRESENTATION);
  const sort = $derived(presentation.sort);
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
  // 标签与书签会卸载目录树，异步焦点交接必须允许视口已经消失。
  let treeViewport: FileTreeViewport | undefined = $state();
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
  const searchClosed = new SvelteSet<string>();
  const contentSearch = $derived(workspace.librarySearch);
  const nameMatches = $derived(
    new Set(
      workspace.entries
        .filter(
          (entry) =>
            !entry.recoveryOnly &&
            entry.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
        .map((entry) => entry.path),
    ),
  );
  const matchingPaths = $derived(
    new Set([...nameMatches, ...contentSearch.hits.map((hit) => hit.path)]),
  );
  const hitByPath = $derived(new Map(contentSearch.hits.map((hit) => [hit.path, hit])));
  const excerptPaths = $derived(
    new Set(
      contentSearch.hits
        .filter((hit) => !nameMatches.has(hit.path) && hit.snippet !== "")
        .map((hit) => hit.path),
    ),
  );
  const expandedPaths = $derived(browser.state.expanded);
  const expanded = $derived(
    searching
      ? new Set(
          [...matchingPaths].flatMap(ancestorDirectories).filter((path) => !searchClosed.has(path)),
        )
      : new Set(expandedPaths),
  );
  const rows = $derived(
    libraryTreeRows(
      workspace.entries,
      expanded,
      sort,
      searching ? matchingPaths : undefined,
      searchClosed,
    ),
  );
  const resultCount = $derived(
    searching
      ? workspace.entries.filter(
          (entry) => entry.kind === "file" && !entry.recoveryOnly && matchingPaths.has(entry.path),
        ).length
      : workspace.entries.filter((entry) => entry.kind === "file" && !entry.recoveryOnly).length,
  );
  $effect(() => {
    void workspace.vaultRoot;
    const text = query,
      suspended = hidden;
    untrack(() => {
      contentSearch.setInput(text, suspended);
      searchClosed.clear();
    });
    return () => contentSearch.reset();
  });
  const selectedEntries = $derived(
    rows.filter((row) => selected.has(row.node.path)).map((row) => row.node),
  );
  const active = $derived(workspace.document.path);
  const activeRecovery = $derived(
    workspace.entries.some((entry) => entry.recoveryOnly && entry.path === active),
  );
  const busy = $derived(workspace.switching || workspace.copying);
  function present(patch: Partial<FilePresentation>): void {
    browser.update({
      presentation: { ...presentation, ...patch },
      ...(patch.sort === undefined ? {} : { scroll: null }),
    });
    if (patch.sort !== undefined) filteredScroll = null;
  }
  const focusable = $derived(
    rows.some((row) => row.node.path === focused)
      ? focused
      : rows.some((row) => row.node.kind === "file" && row.node.path === active)
        ? active
        : (rows.find((row) => row.node.kind === "file")?.node.path ?? rows[0]?.node.path ?? null),
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
          expanded: ancestorDirectories(path),
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
    const node = findFileTreeNode(tree, path);
    browser.update({
      selected: path === null ? [] : [path],
      focused: path,
      ...(node
        ? {
            browse: {
              query,
              section: "files",
              directory: node.kind === "directory" ? node.path : parentDirectory(node.path),
            },
          }
        : {}),
    });
    selectionAnchor = path;
  }
  function selectRow(path: string, mode: "replace" | "toggle" | "range" | "extend"): void {
    const filesOnly =
      findFileTreeNode(tree, path)?.kind === "file" &&
      findFileTreeNode(tree, selectionAnchor)?.kind === "file";
    const next = selectFileRows(
      { paths: selected, anchor: selectionAnchor },
      rows.filter((row) => !filesOnly || row.node.kind === "file").map((row) => row.node.path),
      path,
      mode,
    );
    browser.update({ selected: [...next.paths], focused: path });
    selectionAnchor = next.anchor;
  }
  /**
   * 用户切换浏览目录时结束临时编辑；文件改名的路径映射不调用此入口。
   * @param path 已存在的库内目录，空字符串表示库根。
   * @returns 不返回值；目录持久化失败由工作区统一报告。
   */
  export function enterDirectory(path: string): void {
    previewOpen = false;
    readingFocused = false;
    filteredScroll = null;
    renaming = null;
    renameIssue = "";
    selectionAnchor = null;
    browser.enterDirectory(path);
    selectOnly(path || null);
  }
  /** 查询、分类与目录一次提交到会话，避免视图切换后恢复过时的浏览位置。 */
  function showPane(mode: typeof paneMode, text = ""): void {
    previewOpen = false;
    readingFocused = false;
    if (browser.ready) {
      browser.setQuery(text);
      browser.update({ browse: { ...browser.state.browse!, section: mode } });
    }
  }
  async function focusPath(path: string, select = true): Promise<void> {
    previewOpen = false;
    readingFocused = false;
    if (select) selectOnly(path);
    else browser.update({ focused: path });
    await tick();
    await treeViewport?.focusPath(path);
  }
  /** 关闭窄窗口预览后使原焦点条目可见并接续键盘操作，保留选择与查询。 */
  async function closePreview(): Promise<void> {
    previewOpen = false;
    readingFocused = false;
    await tick();
    if (hidden) return;
    if (focusable !== null) await treeViewport?.focusPath(focusable);
    else searchInput.focus();
  }
  async function activate(entry: VaultEntry): Promise<void> {
    selectOnly(entry.recoveryOnly ? null : entry.path);
    if (entry.kind === "directory") {
      enterDirectory(entry.path);
      await focusPath(entry.path, false);
    } else {
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
    if (kind === "conversations") {
      if (entry && articleAgent) {
        selectOnly(entry.path);
        previewTab = "chat";
        previewOpen = true;
      } else if (entry) onConversations?.(entry.path);
      return;
    }
    if (kind === "bookmark") {
      if (entry !== null) void workspace.bookmarks.toggle(entryBookmark(entry));
      return;
    }
    if (busy) return;
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
    const parent = entry === null ? currentDirectory : parentDirectory(entry.path);
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
    readingFocused = false;
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
  /** 清空搜索，恢复之前的目录选择与滚动位置。 */
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
    if (event.key === "Enter" && query.trim()) {
      event.preventDefault();
      void contentSearch.run(query);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    } else if (event.key === "ArrowDown" && rows[0]) {
      event.preventDefault();
      void focusPath(focusable ?? rows[0].node.path);
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
      browser.update({
        selected: rows
          .filter((item) => !searching || matchingPaths.has(item.node.path))
          .map((item) => item.node.path),
      });
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
    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      if (event.key === "ArrowRight" && row.node.kind === "directory") {
        if (!expanded.has(row.node.path)) toggleFolder(row.node.path);
        else if (rows[rows.indexOf(row) + 1]?.parent === row.node.path)
          void focusPath(rows[rows.indexOf(row) + 1]!.node.path);
      } else if (event.key === "ArrowLeft") {
        if (row.node.kind === "directory" && expanded.has(row.node.path))
          toggleFolder(row.node.path);
        else if (row.parent) void focusPath(row.parent);
      }
      return;
    }
    const next = treeViewport?.nextPath(row.node.path, event.key) ?? undefined;
    if (next !== undefined && next !== null) {
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
  function toggleFolder(path: string): void {
    if (busy) return;
    if (searching) {
      if (searchClosed.has(path)) searchClosed.delete(path);
      else searchClosed.add(path);
    } else
      browser.update({
        expanded: expanded.has(path)
          ? browser.state.expanded.filter((item) => item !== path)
          : [...browser.state.expanded, path],
      });
  }
  function collapseAll(): void {
    const folders = rows.filter((row) => row.node.kind === "directory").map((row) => row.node.path);
    if (searching) {
      if (searchClosed.size) searchClosed.clear();
      else folders.forEach((path) => searchClosed.add(path));
    } else
      browser.update({
        expanded: browser.state.expanded.length
          ? []
          : [
              ...new Set(
                workspace.entries.flatMap((entry) => [
                  ...ancestorDirectories(entry.path),
                  ...(entry.kind === "directory" ? [entry.path] : []),
                ]),
              ),
            ],
      });
  }
  function inputQuery(event: Event & { currentTarget: HTMLInputElement }): void {
    if (event instanceof InputEvent && event.isComposing) return;
    browser.setQuery(event.currentTarget.value);
    filteredScroll = null;
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
  <svg class="entry-icon" viewBox="0 0 20 20" aria-hidden="true">
    {#if row.node.kind === "directory"}<path
        d={expanded.has(row.node.path) ? "m5 7 5 5 5-5" : "m7 5 5 5-5 5"}
      />
    {:else if row.node.path.endsWith(".noemoriboard")}<path d="M3 4h14v12H3zM7 4v12M7 9h10" />
    {:else}<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M8 10h4M8 13h4" />{/if}
  </svg>
{/snippet}

<LibraryFrame
  {workspace}
  {hidden}
  {readFile}
  bind:previewOpen
  bind:previewTab
  bind:focused={readingFocused}
  onFollowLink={(kind, raw, from) => {
    void workspace.openLink(kind, raw, from).then(onOpen);
  }}
  entry={findFileTreeNode(tree, focusable)}
  {...articleAgent ? { articleAgent } : {}}
  query={searching ? query : ""}
  onClosePreview={() => void closePreview()}
  {...onOpenVault === undefined ? {} : { onOpenVault }}
  onCreate={(kind) => onEdit(kind, null, currentDirectory)}
  onOpen={(entry) => void activate(entry)}
  {...onNewWhiteboard === undefined
    ? {}
    : { onNewWhiteboard: () => onNewWhiteboard?.(currentDirectory) }}
>
  <nav class="list" aria-label="文件列表">
    <div class="search-wrap">
      <div class="search">
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg
        >
        <input
          type="text"
          role="searchbox"
          aria-label="搜索笔记库"
          placeholder="搜索笔记库…"
          disabled={busy}
          bind:this={searchInput}
          value={query}
          oninput={inputQuery}
          oncompositionend={inputQuery}
          onkeydown={searchKeydown}
        />
        {#if query !== ""}<button
            type="button"
            class="clear-search"
            aria-label="清除搜索"
            title="清除搜索（Esc）"
            disabled={busy}
            onclick={clearSearch}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button
          >{/if}
      </div>
    </div>
    <div class="view-options">
      <button
        class="root-label"
        type="button"
        aria-label="全部文件"
        title="全部文件"
        class:drop-target={dropTarget === ""}
        onclick={() => enterDirectory("")}
        ondragover={(event) => allowDrop(event, "")}
        ondrop={(event) => void drop(event, "")}>全部文件</button
      >
      <span class="result-count" aria-live="polite"
        >{resultCount}{contentSearch.hasMore && searching ? "+" : ""}</span
      >
      <div class="tools">
        <button
          type="button"
          aria-label="浏览标签"
          title="标签"
          aria-pressed={paneMode === "tags"}
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => showPane(paneMode === "tags" ? "files" : "tags")}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M8 3 6.5 17M14 3l-1.5 14M4 7.5h12M3.5 12.5h12" /></svg
          ></button
        >
        <button
          type="button"
          aria-label="书签"
          title="书签"
          aria-pressed={paneMode === "bookmarks"}
          disabled={busy || workspace.vaultRoot === null}
          onclick={() => showPane(paneMode === "bookmarks" ? "files" : "bookmarks")}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 3h9v14l-4.5-3.5L5.5 17z" /></svg
          ></button
        >
        <button
          type="button"
          aria-label="定位当前文件"
          title="定位当前文件"
          disabled={busy || workspace.isComposing || active === null}
          onclick={() => void locate()}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><circle cx="10" cy="10" r="5" /><path d="M10 2v4m0 8v4M2 10h4m8 0h4" /></svg
          ></button
        >
        <label class="sort" title="排序"
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M4 3v14m-3-3 3 3 3-3M10 5h7M10 9h5M10 13h3" /></svg
          >
          <select
            aria-label="文件排序"
            value={sort === "modified" ? "modified" : "name"}
            onchange={(event) => {
              const value = event.currentTarget.value;
              if (value === "name" || value === "modified") present({ sort: value });
            }}
            ><option value="name">标题顺序</option><option value="modified">最近修改</option
            ></select
          >
        </label>
        <button
          type="button"
          aria-label={(searching ? searchClosed.size === 0 : expanded.size > 0)
            ? "折叠全部目录"
            : "展开全部目录"}
          title={(searching ? searchClosed.size === 0 : expanded.size > 0)
            ? "折叠全部目录"
            : "展开全部目录"}
          disabled={busy}
          onclick={collapseAll}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="m6 3 4 4 4-4M4 10h12m-10 7 4-4 4 4" /></svg
          ></button
        >
      </div>
    </div>
    {#if paneMode === "tags"}<TagBrowser {workspace} onPick={pickTag} />
    {:else if paneMode === "bookmarks"}<BookmarksPane
        bind:this={bookmarksPane}
        {workspace}
        {busy}
        onActivate={(bookmark) => void openBookmark(bookmark)}
      />
    {:else}
      {#if searching && contentSearch.busy}<p class="search-status" role="status">正在搜索…</p>{/if}
      {#if searching && contentSearch.error}<div class="search-error" role="alert">
          {contentSearch.error}
          <button type="button" onclick={() => void contentSearch.run(query)}>重试</button>
        </div>{/if}
      {#if recoveries.length > 0}<section
          class="recovery"
          aria-label="待恢复的笔记"
          bind:this={recoveryElement}
        >
          <h2>待恢复的笔记</h2>
          {#each recoveries as entry (entry.path)}<button
              type="button"
              class="recovery-entry"
              data-path={entry.path}
              aria-current={entry.path === active ? "page" : undefined}
              title={entry.path}
              disabled={busy}
              onclick={() => void activate(entry)}>{entry.path}</button
            >{/each}
        </section>{/if}
      <FileTreeViewport
        bind:this={treeViewport}
        {rows}
        focused={focusable}
        {selected}
        {expanded}
        excerpts={excerptPaths}
        dragging={dragging?.path ?? null}
        position={searching ? filteredScroll : browser.state.scroll}
        onPosition={(position) => {
          if (searching) filteredScroll = position;
          else browser.update({ scroll: position });
        }}
        onEmptyFocus={() => searchInput.focus()}
      >
        {#snippet children(row)}
          <div
            class="file-row"
            class:folder={row.node.kind === "directory"}
            class:active={row.node.path === focusable}
            class:selected={selected.has(row.node.path)}
            class:dragging={dragging?.path === row.node.path}
            class:drop-target={dropTarget === row.node.path}
          >
            {#if renaming?.path === row.node.path}
              {@const entry = renaming}
              <div class="file renaming" data-path={row.node.path} aria-label={row.node.name}>
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
                class="file"
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
                onfocus={() => browser.update({ focused: row.node.path })}
                onclick={(event) => {
                  if (event.shiftKey)
                    selectRow(row.node.path, event.metaKey || event.ctrlKey ? "extend" : "range");
                  else if (event.metaKey || event.ctrlKey) selectRow(row.node.path, "toggle");
                  else {
                    selectOnly(row.node.path);
                    if (row.node.kind === "directory") toggleFolder(row.node.path);
                  }
                }}
                ondblclick={() => void activate(row.node)}
                onkeydown={(event) => keydown(event, row)}
                oncontextmenu={(event) => context(event, row.node)}
                ondragstart={(event) => {
                  if (!selected.has(row.node.path)) selectOnly(row.node.path);
                  draggedEntries = selectedEntries;
                  dragging = row.node;
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
                <span class="file-copy"
                  ><span class="name"
                    ><HighlightedText text={libraryTitle(row.node)} {query} /></span
                  >
                  {#if excerptPaths.has(row.node.path)}<span class="excerpt"
                      ><HighlightedText
                        text={hitByPath.get(row.node.path)?.snippet ?? ""}
                        snippet
                      /></span
                    >{/if}
                </span>
              </button>
              {#if articleCounts[row.node.path]}<button
                  type="button"
                  class="article-conversations"
                  aria-label={`${libraryTitle(row.node)}：${articleCounts[row.node.path]} 条对话`}
                  title="文章对话"
                  onclick={() => {
                    selectOnly(row.node.path);
                    previewTab = "chat";
                    previewOpen = true;
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true"
                    ><path d="M17 9a7 7 0 0 1-10 6.3L3 17l1-4A7 7 0 1 1 17 9Z" /></svg
                  ></button
                >{/if}
            {/if}
          </div>
        {/snippet}
      </FileTreeViewport>
      {#if searching && contentSearch.hasMore}<button
          class="load-more"
          type="button"
          disabled={contentSearch.loadingMore || contentSearch.stale}
          onclick={() => void contentSearch.loadMore()}
          >{contentSearch.loadingMore ? "正在加载…" : "更多结果"}</button
        >{/if}
      {#if renameIssue}<p class="rename-error" id={renameErrorId} role="alert">
          {renameIssue}
        </p>{/if}
      {#if rows.length === 0 && recoveries.length === 0 && !contentSearch.busy}<p class="empty">
          {searching ? "无匹配结果" : "暂无文件"}
        </p>{/if}
    {/if}
    {#if selected.size > 1}<div class="selection-status" aria-live="polite">
        已选 {selected.size} 项
      </div>{/if}
  </nav>
</LibraryFrame>
<FileMenu
  articleConversations={onConversations !== undefined}
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
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: var(--sidebar);
  }
  .search-wrap {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    min-height: 47px;
    box-sizing: border-box;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 33px;
    padding: 0 8px;
    box-sizing: border-box;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
  }
  input {
    width: 100%;
    min-width: 0;
    color: var(--fg);
    background: transparent;
    border: 0;
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .search:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search input:focus-visible {
    outline: none;
    box-shadow: none;
  }
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--selected);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .clear-search {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 26px;
    padding: 0;
  }
  .view-options {
    display: flex;
    align-items: center;
    min-height: 31px;
    padding: 0 10px;
    gap: 6px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
  }
  .root-label {
    padding: 4px;
    white-space: nowrap;
  }
  .result-count {
    font-variant-numeric: tabular-nums;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-left: auto;
  }
  .tools button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 25px;
    min-height: 27px;
    padding: 3px;
  }
  .tools [aria-pressed="true"] {
    color: var(--fg);
    background: var(--selected);
  }
  .sort {
    display: flex;
    align-items: center;
    position: relative;
    min-width: 26px;
    height: 27px;
    justify-content: center;
  }
  .sort select {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    cursor: pointer;
  }
  .sort:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 4px;
  }
  .file-row {
    display: flex;
    height: 100%;
    align-items: center;
    border-radius: 4px;
    margin-left: calc(var(--tree-depth) * 14px);
    position: relative;
  }
  .file-row::before {
    content: "";
    position: absolute;
    left: -7px;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
    opacity: 0.6;
  }
  .file-row.active {
    background: var(--selected);
  }
  .file-row.selected:not(.folder) {
    box-shadow: inset 2px 0 var(--accent);
  }
  .file-row.dragging {
    opacity: 0.5;
  }
  .drop-target {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 2px 6px;
    text-align: left;
    font-size: 12px;
  }
  .file .entry-icon {
    color: var(--muted);
    width: 13px;
    height: 13px;
  }
  .folder .file {
    color: var(--muted);
  }
  .folder .entry-icon {
    width: 11px;
    height: 11px;
  }
  .file-copy {
    min-width: 0;
    flex: 1;
  }
  .name,
  .excerpt {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .excerpt {
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }
  .article-conversations {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 27px;
    height: 100%;
    color: var(--accent);
    padding: 3px;
  }
  .article-conversations svg {
    width: 12px;
    height: 12px;
  }
  .selection-status {
    padding: 6px 13px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
  .empty,
  .search-status {
    padding: 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .search-status {
    padding: 4px 12px;
    margin: 0;
  }
  .search-error,
  .rename-error {
    padding: 8px 12px;
    color: var(--danger);
    font-size: 12px;
  }
  .search-error button {
    margin-left: 8px;
  }
  .load-more {
    min-height: 30px;
    color: var(--accent);
    font-size: 12px;
  }
  .recovery {
    max-height: 30%;
    overflow: auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .recovery h2 {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--warning);
  }
  .recovery-entry {
    display: block;
    width: 100%;
    text-align: left;
    font-size: 12px;
    padding: 5px;
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .tools button,
    .article-conversations,
    .clear-search,
    .sort {
      min-width: 44px;
      min-height: 44px;
    }
    .view-options {
      flex-wrap: wrap;
    }
    input {
      font-size: 16px;
    }
  }
</style>
