<script lang="ts">
  import { tick, untrack } from "svelte";
  import LibraryOptions from "./LibraryOptions.svelte";
  import LibraryIcon, { type LibraryIconName } from "./LibraryIcon.svelte";
  import FileTreeViewport from "./FileTreeViewport.svelte";
  import { libraryTitle } from "./library-tree";
  import {
    buildWorkspaceTree,
    workspaceTreeRows,
    conversationKey,
    type WorkspaceTreeRow,
  } from "./workspace-tree";
  import type {
    WorkspaceConversations,
    WorkspaceConversation,
  } from "../../shared/workspace-conversations";
  import TreeContextMenu from "./TreeContextMenu.svelte";
  import SearchResults from "../search/SearchResults.svelte";
  import SearchStatus from "../search/SearchStatus.svelte";
  import HighlightedText from "./HighlightedText.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import InlineRename from "./InlineRename.svelte";
  import FileBatchDialog from "./FileBatchDialog.svelte";
  import { selectFileRows } from "./file-selection";
  import { type FileTreePosition } from "../../shared/file-browser";
  import { LIBRARY_ENTRIES_MIME } from "../../shared/file-drag";
  import type { EntryBatchResult } from "../../shared/entry-batch";
  import type { EntryDialogAction } from "./FileEntryDialog.svelte";
  import FileMenu, { type FileMenuAction } from "./FileMenu.svelte";
  import type { VaultEntry } from "../../shared/api";
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
    conversations,
    onEdit,
    onOpen,
    hidden = false,
  }: {
    workspace: ReaderWorkspaceController;
    conversations?: WorkspaceConversations;
    onEdit: (
      action: EntryDialogAction | "file" | "directory" | "whiteboard" | "import",
      entry: VaultEntry | null,
      parent: string,
    ) => void;
    onOpen: (focus?: boolean) => void;
    hidden?: boolean;
  } = $props();
  const browser = $derived(workspace.fileTree);
  const conversationExpandedKeys = $derived(browser.state.discussions?.expanded);
  const conversationExpanded = $derived(new Set(conversationExpandedKeys ?? []));
  const discussionPosition = $derived(browser.state.discussions?.scroll);
  const treePosition = $derived(
    discussionPosition
      ? { path: discussionPosition.key, offset: discussionPosition.offset }
      : browser.state.scroll,
  );
  function setConversationExpanded(next: ReadonlySet<string>): void {
    browser.update({
      discussions: {
        archived: showArchived,
        scroll: browser.state.discussions?.scroll ?? null,
        expanded: [...next],
      },
    });
  }
  let conversationFocus = $state<string | null>(null);
  const showArchived = $derived(browser.state.discussions?.archived ?? false);
  let conversationMenu: TreeContextMenu;
  let menuConversation = $state<WorkspaceConversation | null>(null);
  const conversationActions = $derived<
    { id: string; label: string; icon: LibraryIconName; danger?: boolean; separator?: boolean }[]
  >([
    { id: "fork", label: "分叉对话…", icon: "branch" },
    { id: "rename", label: "重命名…", icon: "rename" },
    {
      id: menuConversation?.archived ? "restore" : "archive",
      label: menuConversation?.archived ? "恢复对话" : "归档对话…",
      icon: menuConversation?.archived ? "restore" : "archive",
    },
    { id: "remove", label: "删除对话…", icon: "trash", danger: true, separator: true },
  ]);
  const browse = $derived(browser.state.browse);
  const query = $derived(browse?.query ?? "");
  const currentDirectory = $derived(browse?.directory ?? "");
  const selectedPaths = $derived(browser.state.selected);
  const selected = $derived(new Set(selectedPaths));
  const focused = $derived(browser.state.focused);
  let detailPath = $state<string | null>(null);
  let selectionAnchor = $state<string | null>(null);
  let filteredScroll = $state.raw<FileTreePosition | null>(null);
  let renaming = $state.raw<VaultEntry | null>(null);
  let renameIssue = $state("");
  const renameErrorId = $props.id();
  let treeViewport: FileTreeViewport | undefined = $state();
  let searchInput: HTMLInputElement;
  let menu: FileMenu;
  let batchDialog: FileBatchDialog;
  let draggedEntries = $state.raw<VaultEntry[]>([]);
  let batchFallback: string | null = null;
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
  const contentSearch = $derived(workspace.search);
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
  const hierarchy = $derived(
    buildWorkspaceTree(
      workspace.entries,
      conversations?.items ?? [],
      workspace.vaultRoot,
      showArchived,
    ),
  );
  const expanded = $derived(new Set([...expandedPaths, ...conversationExpanded]));
  const displayRows = $derived(
    workspaceTreeRows(hierarchy, expanded, query, matchingPaths, searchClosed),
  );
  const rows = $derived(
    displayRows.flatMap((row) =>
      row.file
        ? [
            {
              node: row.file,
              depth: row.depth,
              parent: row.parent,
              position: row.position,
              siblings: row.siblings,
            },
          ]
        : [],
    ),
  );
  const expandedRows = $derived(
    searching
      ? new Set(displayRows.filter((row) => !searchClosed.has(row.key)).map((row) => row.key))
      : expanded,
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
    const text = query;
    untrack(() => {
      contentSearch.setInput(text, workspace.vaultRoot === null);
      searchClosed.clear();
      detailPath = null;
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
  const busy = $derived(workspace.copying);
  const focusable = $derived(
    rows.some((row) => row.node.path === focused)
      ? focused
      : rows.some((row) => row.node.kind === "file" && row.node.path === active)
        ? active
        : (rows.find((row) => row.node.kind === "file")?.node.path ?? rows[0]?.node.path ?? null),
  );
  const treeFocus = $derived(
    conversationFocus && displayRows.some((row) => row.key === conversationFocus)
      ? conversationFocus
      : (focusable ?? displayRows[0]?.key ?? null),
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
    conversationFocus = null;
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
    filteredScroll = null;
    renaming = null;
    renameIssue = "";
    selectionAnchor = null;
    browser.enterDirectory(path);
    selectOnly(path || null);
  }
  async function focusPath(path: string, select = true): Promise<void> {
    const row = displayRows.find((row) => row.key === path);
    if (row && !row.file) conversationFocus = path;
    else {
      conversationFocus = null;
      if (select) selectOnly(path);
      else browser.update({ focused: path });
    }
    await tick();
    await treeViewport?.focusPath(path);
  }
  async function moreFiles(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ): Promise<void> {
    const button = event.currentTarget;
    const owned = document.activeElement === button;
    const previous = new Set(contentSearch.hits.map((hit) => hit.path));
    const request = contentSearch.query;
    await contentSearch.loadMore();
    await tick();
    const next = contentSearch.hits.find((hit) => !previous.has(hit.path));
    if (
      next &&
      request === contentSearch.query &&
      owned &&
      (document.activeElement === button || document.activeElement === document.body)
    )
      await focusPath(next.path, false);
  }
  async function openEntry(path: string, focus = false): Promise<void> {
    const hit = hitByPath.get(path);
    const pane = workspace.activePane;
    const match = hit?.matches[0] ?? hit?.evidence?.find((item) => item.location !== null);
    if (searching && hit && match)
      await pane.navigation.openSearchMatch(hit, match, pane.openFile, (message) =>
        workspace.report(message),
      );
    else await pane.openFile(path);
    if (workspace.activePane === pane && pane.document.path === path) onOpen(focus);
  }
  async function activate(entry: VaultEntry): Promise<void> {
    selectOnly(entry.recoveryOnly ? null : entry.path);
    if (entry.kind === "directory") {
      enterDirectory(entry.path);
      await focusPath(entry.path, false);
    } else {
      await openEntry(entry.path, true);
    }
  }
  function action(kind: FileMenuAction, entry: VaultEntry | null): void {
    if (kind === "conversations") {
      if (entry) {
        setConversationExpanded(new Set([...conversationExpanded, entry.path]));
        const first = conversations?.items.find(
          (item) =>
            item.workspace === workspace.vaultRoot &&
            item.article?.path === entry.path &&
            !item.article.removed &&
            !item.archived,
        );
        if (first) void openConversation(first.id);
      }
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
    if (kind === "file" || kind === "whiteboard" || kind === "directory" || kind === "import") {
      const parent = entry?.kind === "directory" ? entry.path : currentDirectory;
      onEdit(kind, null, parent);
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
    browser.setQuery("");
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
    browser.setQuery("");
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
    updateQuery("");
    searchInput.focus();
  }
  function searchKeydown(event: KeyboardEvent): void {
    if (busy || isCompositionKey(event) || workspace.isComposing) return;
    if (event.key === "Enter" && query.trim()) {
      event.preventDefault();
      if (workspace.vaultRoot !== null) void contentSearch.run(query);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    } else if (event.key === "ArrowDown" && displayRows[0]) {
      event.preventDefault();
      void focusPath(treeFocus ?? displayRows[0].key);
    }
  }
  function context(event: MouseEvent, entry: VaultEntry): void {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    if (!selected.has(entry.path)) selectOnly(entry.path);
    browser.update({ focused: entry.path });
    const position = menuPosition(event);
    void menu.open(entry, position.x, position.y);
  }
  // 行内操作使用按钮下方作锚点，键盘合成的 click 坐标为零，不能当成右键位置。
  function menuPosition(event: MouseEvent): { x: number; y: number } {
    if (
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.classList.contains("row-actions")
    ) {
      const bounds = event.currentTarget.getBoundingClientRect();
      return { x: bounds.left, y: bounds.bottom + 4 };
    }
    return { x: event.clientX, y: event.clientY };
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
      const item = displayRows.find((item) => item.key === row.node.path);
      if (
        event.key === "ArrowRight" &&
        item &&
        (item.children.length || item.kind === "directory")
      ) {
        if (!expandedRows.has(item.key)) toggleNode(item);
        else {
          const child = displayRows[displayRows.indexOf(item) + 1];
          if (child?.parent === item.key) void focusPath(child.key);
        }
      } else if (event.key === "ArrowLeft") {
        if (item?.children.length && expandedRows.has(item.key)) toggleNode(item);
        else if (row.parent) void focusPath(row.parent);
      }
      return;
    }
    const next = treeViewport?.nextPath(row.node.path, event.key) ?? undefined;
    if (next !== undefined && next !== null) {
      const target = displayRows.find((row) => row.key === next);
      if (target?.file) {
        if (event.shiftKey) selectRow(next, event.metaKey || event.ctrlKey ? "extend" : "range");
        else if (!event.metaKey && !event.ctrlKey) selectOnly(next);
      }
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
    const folders = displayRows
      .filter((row) => row.children.length || row.kind === "directory")
      .map((row) => row.key);
    if (searching) {
      if (searchClosed.size) searchClosed.clear();
      else folders.forEach((path) => searchClosed.add(path));
    } else {
      const collapse = expanded.size > 0;
      const directories: string[] = [];
      const discussions: string[] = [];
      const pending = [...hierarchy];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.kind === "directory") directories.push(node.key);
        else if (node.children.length) discussions.push(node.key);
        pending.push(...node.children);
      }
      browser.update({
        expanded: collapse ? [] : directories,
        discussions: {
          expanded: collapse ? [] : discussions,
          archived: showArchived,
          scroll: browser.state.discussions?.scroll ?? null,
        },
      });
    }
  }

  function inputQuery(event: Event & { currentTarget: HTMLInputElement }): void {
    if (event instanceof InputEvent && event.isComposing) return;
    updateQuery(event.currentTarget.value);
  }
  // 先向当前场景提交位置，再让查询接管目录；不能依赖异步 scroll 事件的交付顺序。
  function updateQuery(value: string): void {
    treeViewport?.rememberPosition();
    browser.setQuery(value);
    filteredScroll = null;
  }
  async function openConversation(id: string): Promise<void> {
    try {
      await conversations?.open(id);
    } catch (error) {
      workspace.report(String(error));
    }
  }
  function toggleNode(row: WorkspaceTreeRow): void {
    if (row.kind === "directory") {
      toggleFolder(row.key);
      return;
    }
    if (searching) {
      if (searchClosed.has(row.key)) searchClosed.delete(row.key);
      else searchClosed.add(row.key);
    } else {
      const next = new SvelteSet(conversationExpanded);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      setConversationExpanded(next);
    }
  }
  async function openConversationMenu(
    event: MouseEvent,
    item: WorkspaceConversation,
  ): Promise<void> {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    menuConversation = item;
    const position = menuPosition(event);
    await conversationMenu.open(position.x, position.y);
  }
  function conversationKeydown(event: KeyboardEvent, row: WorkspaceTreeRow): void {
    if (event.defaultPrevented || isCompositionKey(event)) return;
    const next = treeViewport?.nextPath(row.key, event.key);
    if (next) {
      event.preventDefault();
      void focusPath(next);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (!row.children.length) return;
      if (!expandedRows.has(row.key)) toggleNode(row);
      else if (row.children[0]) void focusPath(row.children[0].key);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.children.length && expandedRows.has(row.key)) toggleNode(row);
      else if (row.parent) void focusPath(row.parent);
    } else if (
      row.conversation &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      menuConversation = row.conversation;
      const rect =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.getBoundingClientRect()
          : null;
      if (rect) void conversationMenu.open(rect.left + 20, rect.bottom);
    } else if (row.conversation && event.key === "F2") {
      event.preventDefault();
      void conversations
        ?.manage(row.conversation.id, "rename")
        .catch((error) => workspace.report(String(error)));
    } else if (
      row.conversation &&
      !event.repeat &&
      !event.altKey &&
      !event.shiftKey &&
      ((!event.metaKey && !event.ctrlKey && event.key === "Delete") ||
        (event.metaKey && !event.ctrlKey && event.key === "Backspace"))
    ) {
      event.preventDefault();
      void conversations
        ?.manage(row.conversation.id, "remove")
        .catch((error) => workspace.report(String(error)));
    }
  }
  $effect(() => {
    const id = conversations?.selected;
    void workspace.vaultRoot;
    void browser.ready;
    if (!id) return;
    untrack(() => {
      const find = (nodes: typeof hierarchy, ancestors: string[]): boolean => {
        for (const node of nodes) {
          if (node.key === conversationKey(id)) {
            for (const key of ancestors) {
              const file = findFileTreeNode(tree, key);
              if (file?.kind === "directory" && !browser.state.expanded.includes(key))
                browser.update({ expanded: [...browser.state.expanded, key] });
              else setConversationExpanded(new Set([...conversationExpanded, key]));
            }
            return true;
          }
          if (find(node.children, [...ancestors, node.key])) return true;
        }
        return false;
      };
      find(hierarchy, []);
    });
  });
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
  <span class="entry-icon"
    ><LibraryIcon
      name={row.node.kind === "directory"
        ? expandedRows.has(row.node.path)
          ? "folder-open"
          : "folder"
        : row.node.path.endsWith(".noemoriboard")
          ? "whiteboard"
          : "note"}
      size={14}
    /></span
  >
{/snippet}

{#snippet disclosure(item: WorkspaceTreeRow)}
  {#if item.children.length || item.kind === "directory"}
    <button
      type="button"
      class="tree-toggle"
      tabindex="-1"
      aria-label={`${expandedRows.has(item.key) ? "收起" : "展开"} ${item.title}`}
      aria-expanded={expandedRows.has(item.key)}
      title={expandedRows.has(item.key) ? "收起子项" : "展开子项"}
      disabled={busy || renaming?.path === item.key}
      onclick={() => {
        toggleNode(item);
        void focusPath(item.key, false);
      }}
      ><span class="tree-chevron" class:expanded={expandedRows.has(item.key)}
        ><LibraryIcon name="chevron" size={12} /></span
      ></button
    >
  {:else}<span class="tree-spacer" aria-hidden="true"></span>{/if}
{/snippet}

<nav class="list" class:multiple-selection={selected.size > 1} aria-label="文件列表" {hidden}>
  <div class="view-options">
    <div
      class="root-label"
      role="presentation"
      title={workspace.vaultRoot ?? "Noemori 仓库"}
      class:drop-target={dropTarget === ""}
      ondragover={(event) => allowDrop(event, "")}
      ondrop={(event) => void drop(event, "")}
    >
      <h2>Noemori</h2>
    </div>
    <LibraryOptions
      expanded={searching ? searchClosed.size === 0 : expanded.size > 0}
      disabled={busy}
      archived={showArchived}
      onExpand={collapseAll}
      onAction={(action) => {
        if (action === "reveal") void workspace.revealVault();
        else onEdit(action, null, "");
      }}
      {...conversations
        ? {
            onArchive: () =>
              browser.update({
                discussions: {
                  expanded: [...conversationExpanded],
                  scroll: browser.state.discussions?.scroll ?? null,
                  archived: !showArchived,
                },
              }),
          }
        : {}}
    />
  </div>
  <div class="search-wrap">
    <div class="search">
      <LibraryIcon name="search" size={14} />
      <input
        type="text"
        role="searchbox"
        aria-label="搜索笔记库"
        placeholder={conversations ? "搜索文件与对话…" : "搜索文件…"}
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
          onclick={clearSearch}><LibraryIcon name="close" size={13} /></button
        >{/if}
    </div>
  </div>
  {#if searching}<SearchStatus
      search={contentSearch}
      fileCount={resultCount}
      conversationCount={displayRows.filter((row) => row.kind === "conversation").length}
    />{/if}
  {#if recoveries.length > 0}<section class="recovery" aria-label="待恢复的笔记">
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
    rows={displayRows}
    focused={treeFocus}
    {selected}
    expanded={expandedRows}
    excerpts={excerptPaths}
    dragging={dragging?.path ?? null}
    position={searching ? filteredScroll : treePosition}
    onPosition={(position) => {
      if (searching) filteredScroll = position;
      else
        browser.update({
          scroll: position?.path.startsWith("\0") ? null : position,
          discussions: {
            expanded: [...conversationExpanded],
            archived: showArchived,
            scroll: position ? { key: position.path, offset: position.offset } : null,
          },
        });
    }}
    onEmptyFocus={() => searchInput.focus()}
  >
    {#snippet children(item)}
      {#if item.file}
        {@const row = {
          node: item.file,
          depth: item.depth,
          parent: item.parent,
          position: item.position,
          siblings: item.siblings,
        }}
        <div
          class="file-row"
          data-hover-target
          role="presentation"
          class:folder={row.node.kind === "directory"}
          class:active={row.node.kind === "file" && row.node.path === active}
          class:nested={item.depth > 0}
          class:selected={selected.has(row.node.path)}
          class:dragging={dragging?.path === row.node.path}
          class:drop-target={dropTarget === row.node.path}
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
          {@render disclosure(item)}
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
              tabindex={treeFocus === row.node.path ? 0 : -1}
              aria-label={row.node.name}
              aria-keyshortcuts="F2 Delete Meta+Backspace"
              aria-current={row.node.kind === "file" && row.node.path === active
                ? "page"
                : undefined}
              title={row.node.path}
              disabled={busy}
              draggable={!busy}
              onfocus={() => {
                conversationFocus = null;
                browser.update({ focused: row.node.path });
              }}
              onclick={(event) => {
                if (event.shiftKey)
                  selectRow(row.node.path, event.metaKey || event.ctrlKey ? "extend" : "range");
                else if (event.metaKey || event.ctrlKey) selectRow(row.node.path, "toggle");
                else {
                  selectOnly(row.node.path);
                  if (row.node.kind === "directory") toggleFolder(row.node.path);
                  else void openEntry(row.node.path);
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
                const root = workspace.vaultRoot;
                if (root && event.dataTransfer)
                  event.dataTransfer.setData(
                    LIBRARY_ENTRIES_MIME,
                    JSON.stringify({
                      root,
                      entries: draggedEntries.map(({ path, kind }) => ({ path, kind })),
                    }),
                  );
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
              }}
              ondragend={() => {
                dragging = null;
                draggedEntries = [];
                dropTarget = null;
              }}
            >
              {@render entryIcon(row)}
              <span class="file-copy"
                ><span class="name"><HighlightedText text={libraryTitle(row.node)} {query} /></span>
                {#if excerptPaths.has(row.node.path)}<span class="excerpt"
                    ><HighlightedText
                      text={hitByPath.get(row.node.path)?.snippet ?? ""}
                      snippet
                    /></span
                  >{/if}
              </span>
            </button>
            {#if searching && hitByPath.has(item.key)}
              {@const hit = hitByPath.get(item.key)!}
              <button
                type="button"
                class="match-toggle"
                aria-label={`查看 ${hit.title} 的命中详情`}
                title="命中详情"
                aria-expanded={detailPath === item.key}
                onclick={() => (detailPath = detailPath === item.key ? null : item.key)}
                >{hit.matchCount || "···"}</button
              >
            {/if}
          {/if}
          {#if renaming?.path !== row.node.path}
            <button
              type="button"
              class="row-actions"
              tabindex={treeFocus === row.node.path ? 0 : -1}
              aria-label={`${row.node.name} 的操作`}
              title={row.node.kind === "directory" ? "文件夹操作" : "文件操作"}
              aria-haspopup="menu"
              disabled={busy}
              onfocus={() => {
                conversationFocus = null;
                browser.update({ focused: row.node.path });
              }}
              onclick={(event) => context(event, row.node)}
            >
              <LibraryIcon name="more" size={14} />
            </button>
          {/if}
        </div>
      {:else}
        <div
          class="file-row conversation-row"
          data-hover-target
          class:nested={item.depth > 0}
          class:current-conversation={item.conversation?.id === conversations?.selected}
          class:archived={item.conversation?.archived}
        >
          {@render disclosure(item)}
          <button
            class="file"
            type="button"
            data-path={item.key}
            tabindex={treeFocus === item.key ? 0 : -1}
            title={item.conversation
              ? item.conversation.workspace
                ? `${item.title} · ${item.conversation.workspace}`
                : item.title
              : item.title}
            aria-label={item.kind === "source" ? `${item.title}（来源历史）` : item.title}
            aria-pressed={item.conversation
              ? item.conversation.id === conversations?.selected
              : undefined}
            onfocus={() => (conversationFocus = item.key)}
            onclick={() => {
              if (item.conversation) void openConversation(item.conversation.id);
              else toggleNode(item);
            }}
            oncontextmenu={(event) => {
              if (item.conversation) void openConversationMenu(event, item.conversation);
            }}
            onkeydown={(event) => conversationKeydown(event, item)}
          >
            <span class="conversation-icon">
              <span class="entry-icon"
                ><LibraryIcon
                  name={item.conversation?.origin
                    ? "branch"
                    : item.kind === "conversation"
                      ? "conversation"
                      : item.kind === "source"
                        ? "note"
                        : expandedRows.has(item.key)
                          ? "folder-open"
                          : "folder"}
                  size={14}
                /></span
              >
              {#if item.conversation?.id === conversations?.selected}<span
                  class="conversation-active"
                  aria-hidden="true"
                ></span>{/if}
            </span>
            <span class="name"
              ><HighlightedText
                text={item.kind === "workspace"
                  ? item.title.split(/[\\/]/).at(-1) || item.title
                  : item.title}
                {query}
              /></span
            >
            {#if item.kind === "source"}<span class="row-meta">来源历史</span>{/if}
            {#if item.conversation?.status === "running"}<span
                class="run-indicator"
                aria-label="运行中"
                title="运行中"><i></i><i></i><i></i></span
              >{/if}
            {#if item.conversation?.archived}<span class="row-meta">已归档</span>{/if}
          </button>
          {#if item.conversation}
            <button
              type="button"
              class="row-actions"
              tabindex={treeFocus === item.key ? 0 : -1}
              aria-label={`${item.title} 的操作`}
              aria-haspopup="menu"
              title="对话操作"
              disabled={busy}
              onfocus={() => (conversationFocus = item.key)}
              onclick={(event) => {
                if (item.conversation) void openConversationMenu(event, item.conversation);
              }}
            >
              <LibraryIcon name="more" size={14} />
            </button>
          {/if}
        </div>
      {/if}
    {/snippet}
  </FileTreeViewport>
  {#if searching && contentSearch.hasMore}<button
      class="load-more"
      type="button"
      disabled={contentSearch.loadingMore || contentSearch.stale}
      onclick={(event) => void moreFiles(event)}
      >{contentSearch.loadingMore ? "正在加载…" : "更多结果"}</button
    >{/if}
  {#if renameIssue}<p class="rename-error" id={renameErrorId} role="alert">
      {renameIssue}
    </p>{/if}
  {#if displayRows.length === 0 && recoveries.length === 0 && !contentSearch.busy}<p class="empty">
      {searching ? "无匹配结果" : "暂无文件"}
    </p>{/if}
  {#if searching && detailPath && hitByPath.has(detailPath)}<section
      class="search-details"
      aria-label="命中详情"
    >
      <header>
        <span>命中详情</span><button
          type="button"
          aria-label="关闭命中详情"
          onclick={() => (detailPath = null)}>×</button
        >
      </header>
      <SearchResults
        search={contentSearch}
        onlyPath={detailPath}
        activePath={active}
        onActivate={(hit, match) => {
          const pane = workspace.activePane;
          void pane.navigation.openSearchMatch(
            hit,
            match ?? hit.matches[0],
            pane.openFile,
            (message) => workspace.report(message),
          );
        }}
        onExit={() => {
          detailPath = null;
          searchInput.focus();
        }}
        onFocusSearch={() => searchInput.focus()}
      />
    </section>{/if}
  {#if selected.size > 1}<div class="selection-status" aria-live="polite">
      已选 {selected.size} 项
    </div>{/if}
</nav>
<FileMenu
  articleConversations={conversations !== undefined}
  bind:this={menu}
  onAction={action}
  selectionCount={selected.size}
/>
<TreeContextMenu
  bind:this={conversationMenu}
  items={conversationActions}
  label="对话操作"
  onAction={(action) => {
    if (!menuConversation || !conversations) return;
    if (
      action === "rename" ||
      action === "archive" ||
      action === "remove" ||
      action === "fork" ||
      action === "restore"
    )
      void conversations
        .manage(menuConversation.id, action)
        .catch((error) => workspace.report(String(error)));
  }}
/>
<FileBatchDialog
  bind:this={batchDialog}
  {workspace}
  onComplete={reflectBatch}
  onClose={() => void finishBatch()}
/>

<style>
  .search-details {
    display: flex;
    flex-direction: column;
    max-height: 45%;
    min-height: 100px;
    border-top: 1px solid var(--border);
  }
  .search-details header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 12px;
    font-size: 11px;
    color: var(--muted);
  }
  .search-details header button {
    font-size: 18px;
  }
  .match-toggle {
    padding: 0 5px;
    color: var(--muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .list[hidden] {
    display: none;
  }
  .conversation-row .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    color: var(--muted);
    font-size: 10px;
    flex-shrink: 0;
  }
  .run-indicator {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 12px;
    flex-shrink: 0;
  }
  .run-indicator i {
    width: 2px;
    height: 7px;
    border-radius: 1px;
    background: var(--accent);
    animation: conversation-running 1.2s ease-in-out infinite;
  }
  .run-indicator i:nth-child(2) {
    animation-delay: -0.4s;
    height: 11px;
  }
  .run-indicator i:nth-child(3) {
    animation-delay: -0.8s;
    height: 5px;
  }
  .conversation-icon {
    position: relative;
    display: flex;
    flex-shrink: 0;
  }
  .conversation-active {
    position: absolute;
    top: -1px;
    right: -2px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--sidebar);
    animation: conversation-open 320ms var(--motion-ease-spatial);
  }
  .current-conversation .file .entry-icon {
    color: var(--accent);
  }
  @keyframes conversation-open {
    from {
      opacity: 0;
      scale: 0.4;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }
  @keyframes conversation-running {
    0%,
    100% {
      scale: 1 0.4;
      opacity: 0.5;
    }
    50% {
      scale: 1 1;
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .run-indicator i,
    .conversation-active {
      animation: none;
    }
  }
  .archived {
    color: var(--muted);
  }

  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex: 1;
    background: var(--sidebar);
  }
  .search-wrap {
    display: flex;
    align-items: center;
    padding: 0 12px 10px;
    min-height: 38px;
    box-sizing: border-box;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 28px;
    padding: 0 3px;
    box-sizing: border-box;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--muted);
  }
  input {
    width: 100%;
    min-width: 0;
    color: var(--fg);
    background: transparent;
    border: 0;
    font: inherit;
    font-size: 12px;
    outline: none;
  }
  input::placeholder {
    color: var(--muted);
    opacity: 0.8;
  }
  .search:focus-within {
    background: color-mix(in srgb, var(--fg) 3%, transparent);
    border-color: color-mix(in srgb, var(--fg) 12%, transparent);
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
  .file:hover:not(:disabled) {
    background: transparent;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
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
    min-height: 32px;
    padding: 2px 12px 3px;
    box-sizing: border-box;
    gap: 6px;
    color: var(--muted);
  }
  .root-label {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 4px 2px;
    text-align: left;
    font-size: 11px;
    color: var(--muted);
  }
  .root-label h2 {
    margin: 0;
    font: inherit;
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-row {
    display: flex;
    height: 100%;
    align-items: center;
    border-radius: 4px;
    padding-left: min(calc(var(--tree-depth) * 14px), 28%);
    box-sizing: border-box;
    position: relative;
    transition: background var(--motion-fast) var(--motion-ease);
  }
  .file-row:hover {
    background: color-mix(in srgb, var(--fg) 3%, transparent);
  }
  .file-row.nested::before {
    content: "";
    position: absolute;
    left: min(calc(var(--tree-depth) * 14px - 7px), calc(28% - 7px));
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
    opacity: 0.18;
  }
  .file-row.active {
    background: color-mix(in srgb, var(--fg) 6%, transparent);
  }
  .file-row.active .name {
    font-weight: 500;
  }
  .file-row.selected:focus-within:not(.active),
  .multiple-selection .file-row.selected:not(.active) {
    background: color-mix(in srgb, var(--fg) 5%, transparent);
  }
  .current-conversation .name {
    color: var(--fg);
  }
  .file-row:has(.file:focus-visible) {
    outline: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    outline-offset: -1px;
  }
  .file:focus-visible {
    outline: none;
  }
  .row-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 0;
    width: 0;
    height: 24px;
    margin-right: 0;
    padding: 0;
    overflow: hidden;
    color: var(--muted);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }
  .file-row:hover .row-actions,
  .file-row:focus-within .row-actions {
    flex-basis: 24px;
    width: 24px;
    margin-right: 3px;
    opacity: 1;
    pointer-events: auto;
  }
  .row-actions:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
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
    gap: 7px;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 2px 5px 2px 2px;
    text-align: left;
    font-size: 12px;
    line-height: 18px;
  }
  .file .entry-icon {
    display: flex;
    flex-shrink: 0;
    color: color-mix(in srgb, var(--muted) 80%, transparent);
    width: 14px;
    height: 14px;
  }
  .folder .entry-icon {
    color: color-mix(in srgb, var(--muted) 90%, transparent);
  }
  .file-row.active .entry-icon {
    color: var(--accent);
  }
  .file-row:hover .entry-icon {
    color: var(--fg);
  }
  .file-row.active:hover .entry-icon {
    color: var(--accent);
  }
  .file-row.current-conversation:hover .entry-icon {
    color: var(--accent);
  }
  .folder .file {
    color: color-mix(in srgb, var(--fg) 82%, transparent);
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
  .tree-toggle,
  .tree-spacer {
    flex: 0 0 19px;
    width: 19px;
  }
  .tree-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--muted);
    padding: 0;
  }
  .tree-chevron {
    display: flex;
    transition: rotate 160ms var(--motion-ease);
  }
  .tree-chevron.expanded {
    rotate: 90deg;
  }
  .selection-status {
    padding: 6px 13px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
  .empty {
    padding: 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .rename-error {
    padding: 8px 12px;
    color: var(--danger);
    font-size: 12px;
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
    .row-actions,
    .file-row:hover .row-actions,
    .file-row:focus-within .row-actions {
      flex-basis: 44px;
      opacity: 1;
      pointer-events: auto;
      width: 44px;
      height: 44px;
      margin-right: 3px;
    }
    .tree-toggle,
    .clear-search {
      min-width: 44px;
      min-height: 44px;
    }
    .tree-spacer {
      flex-basis: 44px;
      width: 44px;
    }
    .view-options {
      flex-wrap: wrap;
    }
    input {
      font-size: 16px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tree-chevron,
    .file-row,
    .row-actions {
      transition: none;
    }
  }
</style>
