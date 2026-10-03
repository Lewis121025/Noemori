<script lang="ts">
  import ExportDialog from "./export/ExportDialog.svelte";
  import VaultOpening from "./workspace/VaultOpening.svelte";
  import { flushSync, onMount, tick, untrack, type Snippet } from "svelte";
  import ReaderToolbar from "./workspace/ReaderToolbar.svelte";
  import LibraryBrowser from "./library/LibraryBrowser.svelte";
  import QuickNavigation from "./navigation/QuickNavigation.svelte";
  import PaneColumn from "./workspace/PaneColumn.svelte";
  import FileEntryDialog from "./library/FileEntryDialog.svelte";
  import LinkCandidatesDialog from "./links/LinkCandidatesDialog.svelte";
  import DeadLinkDialog from "./links/DeadLinkDialog.svelte";
  import QuickSwitcher from "./navigation/QuickSwitcher.svelte";
  import CommandPalette from "./workspace/CommandPalette.svelte";
  import ConnectionsSpace from "./graph/ConnectionsSpace.svelte";
  import { parentDirectory, type FileEntryChange } from "./library/file-tree";
  import { untitledNotePath, untitledWhiteboardPath } from "./library/library";
  import { emptyWhiteboard, serializeWhiteboard } from "../shared/whiteboard/model";
  import { ReaderWorkspaceController } from "./workspace/state.svelte";
  import { WorkspaceSpaces } from "./workspace/spaces.svelte";
  import { createBrowserMediaIo } from "./preview/media";
  import { SIDEBAR_LAYOUT, type ReaderApi, type ReaderSpace } from "../shared/api";
  import "./styles/controls.css";
  import type { GraphNode, HistoryAction, HistoryAvailability } from "../shared/api";
  import {
    commandAvailable,
    commandForKey,
    type CommandContext,
    type ReaderCommand,
  } from "../shared/commands";
  import { isCompositionKey } from "./editor/composition";
  import { createSessionWrite } from "./session-write";

  /** 每次挂载对应一个阅读器实例，api 在该实例存活期间保持不变。 */
  let { api, applicationMenu }: { api: ReaderApi; applicationMenu: Snippet } = $props();
  // 控制器和资源访问接口共用同一组能力，替换能力时由外壳重新挂载实例。
  const readerApi = untrack(() => api);
  const workspace = new ReaderWorkspaceController(readerApi, persistPanes);
  const spaces = new WorkspaceSpaces(workspace, prepareSpaceInput, persistPanes);
  const mediaIo = createBrowserMediaIo(readerApi);
  // 活动栏文档：命令门禁与重命名等操作的目标随活动栏切换。
  const doc = $derived(workspace.document);
  let filesCollapsed = $state(false);
  const space = $derived(spaces.space);
  let readingSpace: HTMLDivElement | undefined = $state();
  const changingSpace = $derived(spaces.changing);
  let creatingDocument = false;
  let narrow = $state(false);
  let leftWidth = $state(SIDEBAR_LAYOUT.leftWidth);
  const layoutWrites = createSessionWrite({
    delayMs: 300,
    write: async (isCurrent) => {
      if (isCurrent())
        await readerApi.sessionSetPanes({ filesCollapsed, leftWidth, space, mode: workspace.mode });
    },
    report: reportLayoutFailure,
  });
  let entryDialog: FileEntryDialog | undefined = $state();
  let fileList: LibraryBrowser | undefined = $state();
  let fileNavigation: QuickNavigation | undefined = $state();
  let toolbar: ReaderToolbar | undefined = $state();
  /** 当前打开的选择弹层；同一时间至多一个。 */
  let picker = $state<"switcher" | "palette" | null>(null);
  const connectionView = $derived(spaces.connectionView);
  const whiteboard = $derived(doc.content?.kind === "whiteboard");
  const documentVisible = $derived(spaces.documentVisible);

  // 文内链接、阅读历史和分栏激活也可能改变文档种类，页面归属跟随真实文档。
  $effect(() => {
    if (spaces.followDocument()) untrack(focusDocument);
  });
  /** 本次运行用过的命令，最新在前；只服务命令面板排序，不持久化。 */
  let recentCommands = $state<ReaderCommand[]>([]);
  const mac = navigator.userAgent.includes("Mac");

  /** 命令可用性快照；执行门禁与命令面板共用。 */
  function commandContext(): CommandContext {
    return {
      vaultOpen: workspace.vaultRoot !== null,
      hasDocument: documentVisible && doc.path !== null,
      canEdit: documentVisible && doc.canEdit,
      reading: workspace.mode === "reading",
      markdown: doc.content?.kind === "markdown",
      source: workspace.viewMode === "source",
      whiteboard: doc.content?.kind === "whiteboard",
      canBack: documentVisible && workspace.history.canBack,
      canForward: documentVisible && workspace.history.canForward,
    };
  }

  /** 组词与切换期间消费但不执行命令；模态输入框保留自身历史，不修改背后的正文。 */
  export function executeHistory(action: HistoryAction): boolean {
    if (!documentVisible) return false;
    if (changingSpace || workspace.isComposing || workspace.switching) return true;
    if (document.querySelector("dialog[open]")) return false;
    return workspace.navigation.applyHistory(action);
  }

  /** 与执行门禁一致的响应式历史投影；null 交由外壳查询当前原生输入控件。 */
  export function historyAvailability(): HistoryAvailability | null {
    if (!documentVisible) return null;
    if (changingSpace || workspace.isComposing || workspace.switching)
      return { undo: false, redo: false };
    if (document.querySelector("dialog[open]")) return null;
    return workspace.navigation.historyAvailability;
  }

  /** 原生菜单和工作区快捷键共享动作；组词及模态操作期间不能跳转或提交。 */
  export function executeCommand(command: ReaderCommand): void {
    if (
      workspace.isComposing ||
      changingSpace ||
      workspace.switching ||
      workspace.copying ||
      document.querySelector("dialog[open]") ||
      !commandAvailable(command, commandContext())
    )
      return;
    switch (command) {
      case "quick-switcher":
        picker = "switcher";
        break;
      case "command-palette":
        picker = "palette";
        break;
      case "open-vault":
        void openVault();
        break;
      case "open-library":
        void showLibrary();
        break;
      case "new-note":
        if (space === "library") fileList?.beginCreate("file");
        else void startDocument("note");
        break;
      case "new-whiteboard":
        void startDocument("whiteboard");
        break;
      case "insert-whiteboard":
        prepareDocumentAction();
        workspace.navigation.insertWhiteboard();
        break;
      case "new-folder":
        void showLibrary().then(() => {
          if (space === "library") fileList?.beginCreate("directory");
        });
        break;
      case "save":
        workspace.requestSave();
        break;
      case "export-document":
        if (doc.path !== null) workspace.requestExport({ kind: "selection", paths: [doc.path] });
        break;
      case "export-vault":
        workspace.requestExport({ kind: "vault" });
        break;
      case "find":
        prepareDocumentAction();
        workspace.navigation.openSearch();
        break;
      case "find-files":
        void searchFiles();
        break;
      case "insert-attachment":
        prepareDocumentAction();
        workspace.navigation.openAttachments();
        break;
      case "toggle-files":
        if (space !== "writing") void resumeWriting();
        else toggleFilesPane();
        break;
      case "go-back":
        void workspace.navigateBack();
        break;
      case "go-forward":
        void workspace.navigateForward();
        break;
      case "toggle-source":
        void workspace.toggleViewMode();
        break;
      case "toggle-reading":
        void workspace.toggleReadingMode();
        break;
      case "toggle-split":
        void workspace.toggleSplit();
        break;
      case "rename-file":
        beginRename();
        break;
      case "bookmark-file":
        void workspace.bookmarkCurrentFile();
        break;
      case "bookmark-heading":
        void workspace.bookmarkCurrentHeading();
        break;
      case "show-bookmarks":
        void showBookmarks();
        break;
      case "open-graph":
        void spaces.showConnections("graph");
        break;
    }
  }

  /** 图谱节点在活动栏打开；未创建的笔记走死链创建确认。 */
  async function openGraphNode(node: GraphNode): Promise<void> {
    await tick();
    if (node.dead) await workspace.openLink("wiki", node.path);
    else {
      await openFile(node.path);
    }
  }

  /** 命令面板选中后执行；先记下使用顺序，弹层已卸载后再走统一门禁。 */
  async function runFromPalette(command: ReaderCommand): Promise<void> {
    recentCommands = [command, ...recentCommands.filter((id) => id !== command)];
    await tick();
    executeCommand(command);
  }

  onMount(() => {
    updateViewport();
    const dispose = workspace.start();
    let mounted = true;
    void (async () => {
      const restoredSpace = await restorePanes();
      if (!mounted) return;
      spaces.restore(restoredSpace);
      await workspace.restore();
      if (mounted) spaces.restore(restoredSpace);
    })();
    return () => {
      mounted = false;
      layoutWrites.dispose();
      spaces.dispose();
      dispose();
    };
  });

  async function restorePanes(): Promise<ReaderSpace> {
    try {
      const panes = await readerApi.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
      workspace.restoreMode(panes.mode);
      return panes.space ?? "writing";
    } catch (error) {
      workspace.report(
        "文件栏布局未能恢复，已使用默认布局。可重新调整布局；若问题持续，请查看详细原因。",
        error,
      );
      return "writing";
    }
  }

  function persistPanes(): void {
    layoutWrites.request();
    void layoutWrites.flush().catch(reportLayoutFailure);
  }

  function reportLayoutFailure(error: unknown): void {
    workspace.report(
      "文件栏布局未能保存，下次打开可能恢复为原布局。请检查磁盘空间及应用数据目录是否可写，再重新调整布局。",
      error,
    );
  }

  /** 键盘导航也提交属性输入；输入法组词交给保存门禁拒绝，不能强制确认候选。 */
  async function prepareSpaceInput(): Promise<void> {
    if (!workspace.isComposing && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
      await tick();
    }
  }

  async function showLibrary(): Promise<void> {
    if (!(await spaces.showLibrary())) return;
    await tick();
    if (space === "library") fileList?.focusSearch();
  }

  async function resumeWriting(): Promise<void> {
    if (await spaces.resumeWriting()) focusDocument();
  }

  async function openVault(): Promise<void> {
    const before = workspace.vaultRoot;
    await workspace.openVault();
    if (workspace.vaultRoot !== null && workspace.vaultRoot !== before) await showLibrary();
  }

  /** 笔记与白板共用创建门禁、路径冲突规则和焦点交接，只在初始内容上分流。 */
  async function startDocument(kind: "note" | "whiteboard"): Promise<void> {
    if (creatingDocument || changingSpace || workspace.isComposing) return;
    creatingDocument = true;
    try {
      if (workspace.vaultRoot === null) await workspace.openVault("default");
      if (workspace.vaultRoot === null) return;
      const parent = doc.path === null ? "" : parentDirectory(doc.path);
      const path =
        kind === "note"
          ? untitledNotePath(workspace.entries, parent)
          : untitledWhiteboardPath(workspace.entries, parent);
      const error = await workspace.createEntry(
        path,
        "file",
        kind === "whiteboard"
          ? new TextEncoder().encode(serializeWhiteboard(emptyWhiteboard()))
          : undefined,
      );
      if (error !== null) workspace.report(error);
      else finishFileNavigation();
    } finally {
      creatingDocument = false;
    }
  }

  function updateViewport(): void {
    narrow = window.innerWidth <= 640;
  }

  function closeFilesPane(): void {
    filesCollapsed = true;
    persistPanes();
    void tick().then(() => toolbar?.focusFilesToggle());
  }

  function toggleFilesPane(): void {
    if (!filesCollapsed) closeFilesPane();
    else {
      filesCollapsed = false;
      persistPanes();
    }
  }

  function prepareDocumentAction(): boolean {
    if (space !== "writing" || filesCollapsed || !narrow) return false;
    // 原生弹层会在点击事件结束时分配焦点，需要先解除正文的 inert。
    flushSync(() => {
      filesCollapsed = true;
    });
    persistPanes();
    return true;
  }

  function beginRename(): void {
    if (doc.path !== null && !workspace.switching && !workspace.copying)
      void entryDialog?.open("rename", { path: doc.path, kind: "file" }, parentDirectory(doc.path));
  }

  async function searchFiles(): Promise<void> {
    await showLibrary();
    if (space !== "library") return;
    fileList?.focusSearch();
  }

  async function showBookmarks(): Promise<void> {
    await showLibrary();
    if (space !== "library") return;
    await fileList?.showBookmarks();
  }

  function finishFileNavigation(): void {
    spaces.showDocument();
    focusDocument();
  }

  /** 文件打开完成才离开浏览页；活动栏变更使原请求失效，不能借用新栏的路径。 */
  async function openFile(path: string): Promise<void> {
    const pane = workspace.activePane;
    await pane.openFile(path);
    if (workspace.activePane === pane && pane.document.path === path) finishFileNavigation();
  }

  function focusDocument(): void {
    // 所有打开共用焦点交接：先解除 inert 并聚焦活动栏，文本表面再接续选区。
    // 图片、PDF 与空白页也因此有可用的键盘落点。
    prepareDocumentAction();
    const surface = readingSpace;
    const pane = workspace.activePane;
    const epoch = pane.document.epoch;
    void tick().then(() => {
      // 焦点请求只属于发起时的页面、分栏和文档；卸载或新的导航会使它失效。
      if (
        !surface?.isConnected ||
        !documentVisible ||
        workspace.activePane !== pane ||
        pane.document.epoch !== epoch
      )
        return;
      surface
        .querySelector<HTMLElement>(`[data-pane="${pane.id}"]`)
        ?.focus({ preventScroll: true });
      pane.navigation.focusEditor();
    });
  }

  async function finishEntryOperation(change: FileEntryChange): Promise<void> {
    const writing =
      change.action === "create" && change.entry.kind === "file" && doc.path === change.entry.path;
    await fileList?.reflectChange(change, space === "library" && !writing);
    if (writing) finishFileNavigation();
    else if (space === "writing" && change.action === "trash") await fileNavigation?.focusFiles();
  }

  function onWorkspaceShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || isCompositionKey(event) || workspace.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    if (
      event.key === "Escape" &&
      space === "writing" &&
      narrow &&
      !filesCollapsed &&
      !(event.target instanceof Element && event.target.closest("[popover]"))
    ) {
      event.preventDefault();
      closeFilesPane();
      return;
    }
    if (workspace.switching || workspace.copying) return;
    // 菜单加速键被系统消费时（含合成按键）由工作区兜底，与菜单同一张命令表。
    const command = commandForKey(event);
    if (command !== null) {
      event.preventDefault();
      executeCommand(command);
    }
  }

  /** @returns 当前编辑已安全保存时允许关闭；冲突或写入失败时由应用外壳保留窗口。 */
  export async function flushBeforeClose(): Promise<boolean> {
    try {
      await layoutWrites.flush();
    } catch (error) {
      reportLayoutFailure(error);
      return false;
    }
    return workspace.flushBeforeClose();
  }
</script>

<svelte:window
  onkeydown={onWorkspaceShortcut}
  onresize={updateViewport}
  oncompositionstart={() => workspace.setComposing(true)}
  oncompositionend={() => workspace.setComposing(false)}
/>
<div class="app">
  <ReaderToolbar
    bind:this={toolbar}
    {workspace}
    {space}
    {changingSpace}
    {filesCollapsed}
    onLibrary={() => void showLibrary()}
    onResume={() => void resumeWriting()}
    onConnections={() => void spaces.showConnections()}
    {documentVisible}
    onSearch={() => {
      picker = "switcher";
    }}
    onNewNote={() => void startDocument("note")}
    onNewWhiteboard={() => void startDocument("whiteboard")}
    onOpenVault={() => void openVault()}
    onToggleFiles={toggleFilesPane}
    onRename={beginRename}
    onDocumentAction={prepareDocumentAction}
    {applicationMenu}
  />
  <VaultOpening {workspace} />
  <div class="panes">
    {#if space === "connections"}
      <ConnectionsSpace
        {workspace}
        view={connectionView}
        busy={changingSpace || workspace.switching || workspace.copying || workspace.isComposing}
        onView={(view) => void spaces.showConnections(view)}
        onOpen={(path) => void openFile(path)}
        onGraphNode={(node) => void openGraphNode(node)}
        onNew={() => void startDocument("whiteboard")}
      />
    {/if}
    {#if space === "writing" && whiteboard}
      <section class="writing-empty" aria-label="开始写作">
        <h1>留一点空间，给新的想法。</h1>
        <button
          class="reader-button primary"
          type="button"
          onclick={() => void startDocument("note")}>新建笔记</button
        >
      </section>
    {/if}
    <div
      class="reading-space"
      bind:this={readingSpace}
      inert={!documentVisible}
      aria-hidden={!documentVisible}
    >
      {#if !filesCollapsed && space === "writing"}
        <button class="files-scrim" type="button" aria-label="收起文件栏" onclick={closeFilesPane}
        ></button>
      {/if}
      <QuickNavigation
        bind:this={fileNavigation}
        {workspace}
        hidden={filesCollapsed || space !== "writing"}
        width={leftWidth}
        onOpen={(path) => void openFile(path)}
        onTrash={(entry) => void entryDialog?.open("trash", entry, parentDirectory(entry.path))}
        onWidth={(width) => {
          leftWidth = width;
          layoutWrites.request();
        }}
      />
      {#each workspace.panes as pane (pane.id)}
        <PaneColumn
          {workspace}
          {pane}
          {mediaIo}
          narrowInert={space === "writing" && narrow && !filesCollapsed}
          {filesCollapsed}
          onToggleFiles={toggleFilesPane}
          onNewNote={() => void startDocument("note")}
          onOpenVault={() => void openVault()}
        />
      {/each}
    </div>
    <LibraryBrowser
      bind:this={fileList}
      onOpen={finishFileNavigation}
      {workspace}
      hidden={space !== "library"}
      readFile={readerApi.fileRead}
      onEdit={(action, entry, parent) => void entryDialog?.open(action, entry, parent)}
    />
  </div>
  {#if workspace.exportScope !== null}<ExportDialog {workspace} />{/if}
  {#if workspace.deadLinkOffer !== null}
    <DeadLinkDialog
      path={workspace.deadLinkOffer.path}
      anchor={workspace.deadLinkOffer.anchor}
      onConfirm={() => {
        const path = workspace.deadLinkOffer?.path;
        void workspace.confirmDeadLink().then(() => {
          if (doc.path === path) finishFileNavigation();
        });
      }}
      onDismiss={workspace.dismissDeadLink}
    />
  {/if}
  <FileEntryDialog
    bind:this={entryDialog}
    {workspace}
    onComplete={(change) => void finishEntryOperation(change)}
  />
  {#if picker === "switcher"}
    <QuickSwitcher
      {workspace}
      {mac}
      onClose={() => {
        picker = null;
      }}
      onOpened={() => finishFileNavigation()}
      onCreated={(path) =>
        void finishEntryOperation({ action: "create", entry: { path, kind: "file" } })}
    />
  {:else if picker === "palette"}
    <CommandPalette
      available={(id) => commandAvailable(id, commandContext())}
      recent={recentCommands}
      {mac}
      onRun={(id) => void runFromPalette(id)}
      onClose={() => {
        picker = null;
      }}
    />
  {/if}
  {#if workspace.linkCandidates !== null}
    <LinkCandidatesDialog
      paths={workspace.linkCandidates.paths}
      anchor={workspace.linkCandidates.anchor}
      onChoose={(path) =>
        void workspace.chooseLinkCandidate(path).then(() => {
          if (doc.path === path) finishFileNavigation();
        })}
      onDismiss={workspace.dismissLinkCandidates}
    />
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .reading-space {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .reading-space[inert] {
    /* 保持滚动容器尺寸，资料管理期间保存的阅读锚点不能来自零尺寸布局。 */
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .writing-empty {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 1.5rem;
    flex: 1;
  }
  .writing-empty h1 {
    font-size: 1.5rem;
    font-weight: 500;
  }
  .files-scrim {
    display: none;
  }
  /* 分栏之间的视觉分隔；相邻选择器跨组件实例，需要全局作用域。 */
  .panes :global(.pane-column + .pane-column) {
    border-left: 1px solid var(--border);
  }
  @media (max-width: 640px) {
    .panes {
      position: relative;
    }
    .files-scrim {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 1;
      background: var(--scrim);
      border: 0;
      padding: 0;
    }
  }
</style>
