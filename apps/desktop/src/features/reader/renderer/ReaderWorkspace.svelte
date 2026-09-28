<script lang="ts">
  import { flushSync, onMount, tick, untrack, type Snippet } from "svelte";
  import ReaderToolbar from "./components/workspace/ReaderToolbar.svelte";
  import FileList from "./components/files/FileList.svelte";
  import QuickNavigation from "./components/navigation/QuickNavigation.svelte";
  import PaneColumn from "./components/workspace/PaneColumn.svelte";
  import FileEntryDialog from "./components/files/FileEntryDialog.svelte";
  import LinkCandidatesDialog from "./components/workspace/LinkCandidatesDialog.svelte";
  import DeadLinkDialog from "./components/workspace/DeadLinkDialog.svelte";
  import QuickSwitcher from "./components/workspace/QuickSwitcher.svelte";
  import CommandPalette from "./components/workspace/CommandPalette.svelte";
  import GraphDialog from "./components/graph/GraphDialog.svelte";
  import { parentDirectory, type FileEntryChange } from "./engine/navigation/file-tree";
  import { untitledNotePath } from "./engine/navigation/library";
  import { ReaderWorkspaceController } from "./state/workspace.svelte";
  import { createBrowserMediaIo } from "./engine/media/media";
  import { SIDEBAR_LAYOUT, type ReaderApi, type ReaderSpace } from "../shared/api";
  import "./styles/controls.css";
  import type { GraphNode, HistoryAction, HistoryAvailability } from "../shared/api";
  import {
    commandAvailable,
    commandForKey,
    type CommandContext,
    type ReaderCommand,
  } from "../shared/commands";
  import { isCompositionKey } from "./engine/editing/composition";

  /** 每次挂载对应一个阅读器实例，api 在该实例存活期间保持不变。 */
  let { api, applicationMenu }: { api: ReaderApi; applicationMenu: Snippet } = $props();
  // 控制器和资源访问接口共用同一组能力，替换能力时由外壳重新挂载实例。
  const readerApi = untrack(() => api);
  const workspace = new ReaderWorkspaceController(readerApi);
  const mediaIo = createBrowserMediaIo(readerApi);
  // 活动栏文档：命令门禁与重命名等操作的目标随活动栏切换。
  const doc = $derived(workspace.document);
  let filesCollapsed = $state(false);
  let space = $state<ReaderSpace>("writing");
  let readingSpace: HTMLDivElement | undefined = $state();
  let changingSpace = $state(false);
  let creatingNote = false;
  let layoutWrites = Promise.resolve();
  let narrow = $state(false);
  let leftWidth = $state(SIDEBAR_LAYOUT.leftWidth);
  let entryDialog: FileEntryDialog | undefined = $state();
  let fileList: FileList | undefined = $state();
  let toolbar: ReaderToolbar | undefined = $state();
  /** 当前打开的选择弹层；同一时间至多一个。 */
  let picker = $state<"switcher" | "palette" | null>(null);
  let graphOpen = $state(false);
  /** 本次运行用过的命令，最新在前；只服务命令面板排序，不持久化。 */
  let recentCommands = $state<ReaderCommand[]>([]);
  const mac = navigator.userAgent.includes("Mac");

  /** 命令可用性快照；执行门禁与命令面板共用。 */
  function commandContext(): CommandContext {
    return {
      vaultOpen: workspace.vaultRoot !== null,
      hasDocument: space === "writing" && doc.path !== null,
      canEdit: space === "writing" && doc.canEdit,
      reading: workspace.viewMode === "reading",
      markdown: doc.content?.kind === "markdown",
      canBack: space === "writing" && workspace.history.canBack,
      canForward: space === "writing" && workspace.history.canForward,
    };
  }

  /** 组词与切换期间消费但不执行命令；模态输入框保留自身历史，不修改背后的正文。 */
  export function executeHistory(action: HistoryAction): boolean {
    if (space === "library") return false;
    if (workspace.isComposing || workspace.switching) return true;
    if (document.querySelector("dialog[open]")) return false;
    return workspace.navigation.applyHistory(action);
  }

  /** 与执行门禁一致的响应式历史投影；null 交由外壳查询当前原生输入控件。 */
  export function historyAvailability(): HistoryAvailability | null {
    if (space === "library") return null;
    if (workspace.isComposing || workspace.switching) return { undo: false, redo: false };
    if (document.querySelector("dialog[open]")) return null;
    return workspace.navigation.historyAvailability;
  }

  /** 原生菜单和工作区快捷键共享动作；组词及模态操作期间不能跳转或提交。 */
  export function executeCommand(command: ReaderCommand): void {
    if (
      workspace.isComposing ||
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
        else void startNote();
        break;
      case "new-folder":
        void showLibrary().then(() => {
          if (space === "library") fileList?.beginCreate("directory");
        });
        break;
      case "save":
        workspace.requestSave();
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
        if (space === "library") resumeWriting();
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
        graphOpen = true;
        break;
    }
  }

  /** 图谱节点在活动栏打开；未创建的笔记走死链创建确认。 */
  async function openGraphNode(node: GraphNode): Promise<void> {
    await tick();
    if (node.dead) await workspace.openLink("wiki", node.path);
    else {
      await workspace.openFile(node.path);
      if (doc.path === node.path) finishFileNavigation();
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
    void (async () => {
      await restorePanes();
      await workspace.restore();
    })();
    return dispose;
  });

  async function restorePanes(): Promise<void> {
    try {
      const panes = await readerApi.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
      space = panes.space ?? "writing";
    } catch (error) {
      workspace.report(
        "文件栏布局未能恢复，已使用默认布局。可重新调整布局；若问题持续，请查看详细原因。",
        error,
      );
    }
  }

  function persistPanes(): void {
    const snapshot = { filesCollapsed, leftWidth, space };
    layoutWrites = layoutWrites
      .then(() => readerApi.sessionSetPanes(snapshot))
      .catch((error: unknown) => {
        workspace.report(
          "文件栏布局未能保存，下次打开可能恢复为原布局。请检查磁盘空间及应用数据目录是否可写，再重新调整布局。",
          error,
        );
      });
  }

  async function showLibrary(): Promise<void> {
    if (space === "library" || changingSpace) return;
    changingSpace = true;
    try {
      // 键盘进入管理也先结束普通输入控件的编辑，与点击入口的失焦提交保持一致。
      // 组词中的内容由保存门禁拒绝，不能通过 blur 擅自确认候选文字。
      if (!workspace.isComposing && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
        await tick();
      }
      if (!(await workspace.prepareLibrary())) return;
      space = "library";
      persistPanes();
      await tick();
      fileList?.focusSearch();
    } finally {
      changingSpace = false;
    }
  }

  function resumeWriting(): void {
    finishFileNavigation();
  }

  async function openVault(): Promise<void> {
    const before = workspace.vaultRoot;
    await workspace.openVault();
    if (workspace.vaultRoot !== null && workspace.vaultRoot !== before) await showLibrary();
  }

  async function startNote(): Promise<void> {
    if (creatingNote || workspace.isComposing) return;
    creatingNote = true;
    try {
      if (workspace.vaultRoot === null) await workspace.openVault("default");
      if (workspace.vaultRoot === null) return;
      const parent = doc.path === null ? "" : parentDirectory(doc.path);
      const path = untitledNotePath(workspace.entries, parent);
      const error = await workspace.createEntry(path, "file");
      if (error !== null) workspace.report(error);
      else finishFileNavigation();
    } finally {
      creatingNote = false;
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
    if (filesCollapsed || !narrow) return false;
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
    if (space !== "writing") {
      space = "writing";
      persistPanes();
    }
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
        space !== "writing" ||
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
    await layoutWrites;
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
    onResume={resumeWriting}
    onSearch={() => {
      picker = "switcher";
    }}
    onNewNote={() => void startNote()}
    onOpenVault={() => void openVault()}
    onToggleFiles={toggleFilesPane}
    onRename={beginRename}
    onDocumentAction={prepareDocumentAction}
    {applicationMenu}
  />
  <div class="panes">
    <div
      class="reading-space"
      bind:this={readingSpace}
      inert={space !== "writing"}
      aria-hidden={space !== "writing"}
    >
      {#if !filesCollapsed && space === "writing"}
        <button class="files-scrim" type="button" aria-label="收起文件栏" onclick={closeFilesPane}
        ></button>
      {/if}
      <QuickNavigation
        {workspace}
        hidden={filesCollapsed}
        width={leftWidth}
        onLibrary={() => void showLibrary()}
        onOpen={(path) =>
          void workspace.openFile(path).then(() => {
            if (workspace.document.path === path) finishFileNavigation();
          })}
        onWidth={(width) => {
          leftWidth = width;
          persistPanes();
        }}
      />
      {#each workspace.panes as pane (pane.id)}
        <PaneColumn
          {workspace}
          {pane}
          {mediaIo}
          narrowInert={narrow && !filesCollapsed}
          {filesCollapsed}
          onToggleFiles={toggleFilesPane}
          onNewNote={() => void startNote()}
          onOpenVault={() => void openVault()}
        />
      {/each}
    </div>
    <FileList
      bind:this={fileList}
      onOpen={finishFileNavigation}
      {workspace}
      hidden={space !== "library"}
      readFile={readerApi.fileRead}
      onEdit={(action, entry, parent) => void entryDialog?.open(action, entry, parent)}
    />
  </div>
  {#if workspace.deadLinkOffer !== null}
    <DeadLinkDialog
      path={workspace.deadLinkOffer.path}
      anchor={workspace.deadLinkOffer.anchor}
      onConfirm={() => void workspace.confirmDeadLink()}
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
  {#if graphOpen}
    <GraphDialog
      {workspace}
      onClose={() => {
        graphOpen = false;
      }}
      onOpen={(node) => void openGraphNode(node)}
    />
  {/if}
  {#if workspace.linkCandidates !== null}
    <LinkCandidatesDialog
      paths={workspace.linkCandidates.paths}
      anchor={workspace.linkCandidates.anchor}
      onChoose={(path) => void workspace.chooseLinkCandidate(path)}
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
  .files-scrim {
    display: none;
  }
  /* 分栏之间的视觉分隔；相邻选择器跨组件实例，需要全局作用域。 */
  .panes :global(.main + .main) {
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
