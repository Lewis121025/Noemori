<script lang="ts">
  import ExportDialog from "./export/ExportDialog.svelte";
  import VaultOpening from "./workspace/VaultOpening.svelte";
  import { flushSync, onMount, tick, untrack, type Snippet } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import WindowToolbar from "./workspace/WindowToolbar.svelte";
  import SettingsWindow from "./workspace/SettingsWindow.svelte";
  import LinksDock from "./links/LinksDock.svelte";
  import LibraryBrowser from "./library/LibraryBrowser.svelte";
  import QuickNavigation from "./navigation/QuickNavigation.svelte";
  import {
    SIDEBAR_COMPONENTS,
    type SidebarEntry,
    type SidebarPanel,
  } from "./navigation/sidebar-components";
  import PaneColumn from "./workspace/PaneColumn.svelte";
  import FileEntryDialog from "./library/FileEntryDialog.svelte";
  import LinkCandidatesDialog from "./links/LinkCandidatesDialog.svelte";
  import DeadLinkDialog from "./links/DeadLinkDialog.svelte";
  import QuickSwitcher from "./navigation/QuickSwitcher.svelte";
  import CommandPalette from "./workspace/CommandPalette.svelte";
  import type { PaneControls } from "./workspace/pane-controls";
  import { parentDirectory, type FileEntryChange } from "./library/file-tree";
  import {
    libraryCreationDirectory,
    untitledNotePath,
    untitledWhiteboardPath,
  } from "./library/library";
  import { emptyWhiteboard, serializeWhiteboard } from "../shared/whiteboard/model";
  import { ReaderWorkspaceController } from "./workspace/state.svelte";
  import { WorkspaceSpaces } from "./workspace/spaces.svelte";
  import { createBrowserMediaIo } from "./preview/media";
  import { SIDEBAR_LAYOUT, type ReaderApi, type PaneLayout } from "../shared/api";
  import "./styles/controls.css";
  import "./styles/motion.css";
  import { interactionFeedback } from "./motion";
  import { sidebarMotion } from "./sidebar-motion";
  import { paletteMotion } from "./palette-motion";
  import type { HistoryAction, HistoryAvailability } from "../shared/api";
  import {
    commandAvailable,
    commandForKey,
    type CommandContext,
    type ReaderCommand,
  } from "../shared/commands";
  import { isCompositionKey } from "./editor/composition";
  import { createSessionWrite } from "./session-write";
  import { READING_FONTS, type ReadingFont } from "../shared/reading-font";
  import { DEFAULT_READING_PALETTE, type ReadingPalette } from "../shared/reading-palette";

  /** 每次挂载对应一个阅读器实例，api 在该实例存活期间保持不变。 */
  let {
    api,
    applicationMenu,
    palette = DEFAULT_READING_PALETTE,
  }: {
    api: ReaderApi;
    applicationMenu: Snippet;
    /** 配色只影响样式变量，不重建文档或修改阅读位置。 */
    palette?: ReadingPalette;
  } = $props();
  // 控制器和资源访问接口共用同一组能力，替换能力时由外壳重新挂载实例。
  const readerApi = untrack(() => api);
  const workspace = new ReaderWorkspaceController(readerApi, () => layoutWrites.request());
  const spaces = new WorkspaceSpaces(workspace, prepareSpaceInput, persistPanes);
  const mediaIo = createBrowserMediaIo(readerApi);
  // 活动栏文档：命令门禁与重命名等操作的目标随活动栏切换。
  const doc = $derived(workspace.document);
  let filesCollapsed = $state(false);
  let selectedComponent = $state<SidebarEntry["id"]>("outline");
  const selectedEntry = $derived(
    SIDEBAR_COMPONENTS.find((entry) => entry.id === selectedComponent),
  );
  const sidebarPanel = $derived(selectedEntry?.kind === "panel" ? selectedEntry.id : "outline");
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
        await readerApi.sessionSetPanes({
          filesCollapsed,
          leftWidth,
          destination: space,
          sidebarView: workspace.sidebarView,
          searchQuery: workspace.search.input,
        });
    },
    report: reportLayoutFailure,
  });
  let entryDialog: FileEntryDialog | undefined = $state();
  let fileList: LibraryBrowser | undefined = $state();
  let fileNavigation: QuickNavigation | undefined = $state();
  let windowToolbar: WindowToolbar | undefined = $state();
  let settingsWindow: SettingsWindow | undefined = $state();
  const paneControls = new SvelteMap<number, PaneControls>();

  /** 分栏保有工具的编辑器归属，工作区只决定顶栏操作与侧栏目录的展示位置。 */
  function registerControls(id: number, controls: PaneControls | null): void {
    if (controls === null) paneControls.delete(id);
    else paneControls.set(id, controls);
  }
  /** 当前打开的选择弹层；同一时间至多一个。 */
  let picker = $state<"switcher" | "palette" | "split" | null>(null);
  let pickerOpening = $state(0);
  function openPicker(kind: NonNullable<typeof picker>): void {
    // 同类型弹窗快速重开也属于新会话，不能复用尚在退出的查询和异步请求。
    pickerOpening += 1;
    picker = kind;
  }
  const documentVisible = $derived(spaces.documentVisible);
  let contentWidth = $state(0);
  let contentElement: HTMLDivElement;
  const compactSplit = $derived(workspace.split && contentWidth < 640);
  /** 本次运行用过的命令，最新在前；只服务命令面板排序，不持久化。 */
  let recentCommands = $state<ReaderCommand[]>([]);
  const mac = navigator.userAgent.includes("Mac");

  /**
   * 应用阅读字体并保留各栏锚点；不改选区、源码或编辑历史。
   * @param font 宿主已加载并保存的精选字体标识。
   * @returns 当前各栏完成重排与定位后兑现；已切换的文档不恢复旧锚点。
   * @throws 编辑器定位异常保留原始原因，交由字体选择入口提示。
   */
  export async function applyReadingFont(font: ReadingFont): Promise<void> {
    // 在改字体与等待布局之前登记恢复，沿用导航自身的代次与用户取消机制。
    const layout = tick().then(() => document.fonts.ready);
    const restoring = workspace.panes
      .filter((pane) => pane.viewMode !== "source" && pane.document.content?.kind === "markdown")
      .map((pane) => {
        const position = pane.navigation.capturePosition();
        return position === null
          ? Promise.resolve()
          : pane.navigation.restorePosition({ reading: position.reading, selection: null }, layout);
      });
    document.documentElement.style.setProperty("--font-document", READING_FONTS[font].family);
    await Promise.all([layout, ...restoring]);
  }

  /** 命令可用性快照；执行门禁与命令面板共用。 */
  function commandContext(): CommandContext {
    return {
      vaultOpen: workspace.vaultRoot !== null,
      hasDocument: documentVisible && doc.path !== null,
      canEdit: documentVisible && doc.canEdit,
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
        openPicker("switcher");
        break;
      case "open-settings":
        settingsWindow?.open();
        break;
      case "command-palette":
        openPicker("palette");
        break;
      case "open-vault":
        void openVault();
        break;
      case "open-library":
        void showLibrary();
        break;
      case "new-note":
        void startDocument("note");
        break;
      case "new-whiteboard":
        void startDocument("whiteboard");
        break;
      case "insert-whiteboard":
        prepareDocumentAction();
        workspace.navigation.insertWhiteboard();
        break;
      case "insert-webpage":
        prepareDocumentAction();
        workspace.navigation.insertWebPage();
        break;
      case "new-folder":
        void entryDialog?.open("directory", null, creationDirectory());
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
        showDocumentTools();
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
        toggleFilesPane();
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
      case "toggle-split":
        void toggleSplit();
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
    const observer = new ResizeObserver(() => {
      contentWidth = contentElement.clientWidth;
    });
    observer.observe(contentElement);
    contentWidth = contentElement.clientWidth;
    const dispose = workspace.start();
    let mounted = true;
    void (async () => {
      const restoredSpace = await restorePanes();
      if (!mounted) return;
      await workspace.restore();
      if (mounted) {
        spaces.restore(restoredSpace);
        workspace.sidebarView = restoredSpace.sidebarView ?? "outline";
        selectedComponent = spaces.space === "library" ? "open-library" : workspace.sidebarView;
        workspace.search.setInput(restoredSpace.searchQuery ?? "");
      }
    })();
    return () => {
      mounted = false;
      observer.disconnect();
      layoutWrites.dispose();
      spaces.dispose();
      dispose();
    };
  });

  async function restorePanes(): Promise<PaneLayout> {
    try {
      const panes = await readerApi.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
      return panes;
    } catch (error) {
      workspace.report(
        "文件栏布局未能恢复，已使用默认布局。可重新调整布局；若问题持续，请查看详细原因。",
        error,
      );
      return { filesCollapsed: false, leftWidth: SIDEBAR_LAYOUT.leftWidth };
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
    selectedComponent = "open-library";
    prepareDocumentAction();
    await tick();
    if (space === "library") fileList?.focusSearch();
  }

  async function resumeWriting(): Promise<void> {
    if (await spaces.resumeWriting()) {
      if (selectedEntry?.kind === "command") selectedComponent = workspace.sidebarView;
      focusDocument();
    }
  }

  async function openVault(): Promise<void> {
    const before = workspace.vaultRoot;
    await workspace.openVault();
    if (workspace.vaultRoot !== null && workspace.vaultRoot !== before) {
      await resumeWriting();
      persistPanes();
    }
  }

  /** 新建动作以当前浏览位置为准；返回文档后才使用文档所在目录。 */
  function creationDirectory(): string {
    if (space !== "library") return doc.path === null ? "" : parentDirectory(doc.path);
    const { selected, browse } = workspace.fileTree.state;
    const entry =
      selected.length === 1
        ? workspace.entries.find((entry) => entry.path === selected[0])
        : undefined;
    return libraryCreationDirectory(entry ?? null, browse?.directory ?? "");
  }

  /** 笔记与白板共用创建门禁、路径冲突规则和焦点交接，只在初始内容上分流。 */
  async function startDocument(
    kind: "note" | "whiteboard",
    parentOverride?: string,
  ): Promise<void> {
    if (creatingDocument || changingSpace || workspace.isComposing) return;
    creatingDocument = true;
    try {
      if (workspace.vaultRoot === null) await workspace.openVault("default");
      if (workspace.vaultRoot === null) return;
      const parent = parentOverride ?? creationDirectory();
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
    void tick().then(() => windowToolbar?.focusSidebarToggle());
  }

  function toggleFilesPane(): void {
    if (!filesCollapsed) closeFilesPane();
    else {
      filesCollapsed = false;
      persistPanes();
    }
  }

  /** 双栏开关关闭非活动栏，保留当前文档；关闭前仍通过该栏的保存门禁。 */
  async function toggleSplit(): Promise<void> {
    if (changingSpace || workspace.switching || workspace.copying || workspace.isComposing) return;
    if (workspace.split) {
      const other = workspace.panes.find((pane) => pane !== workspace.activePane);
      if (other) await workspace.closePane(other.id);
    } else openPicker("split");
  }

  function showDocumentTools(): void {
    workspace.navigation.cancelPositionRestore();
    prepareDocumentAction();
  }

  /** 组件切换保留挂载；返回文档工具时先通过已有页面门禁，不重新加载正文。 */
  async function selectSidebarPanel(panel: SidebarPanel): Promise<void> {
    if (workspace.isComposing || changingSpace) return;
    if (panel !== "search" && !documentVisible) {
      if (!(await spaces.resumeWriting())) return;
    }
    selectedComponent = panel;
    workspace.setSidebarView(panel);
    if (panel === "search") await fileNavigation?.focusSearch();
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
    workspace.setSidebarView("search");
    selectedComponent = "search";
    filesCollapsed = false;
    persistPanes();
    await fileNavigation?.focusSearch();
  }

  async function showBookmarks(): Promise<void> {
    await showLibrary();
    if (space !== "library") return;
    await fileList?.showBookmarks();
  }

  function finishFileNavigation(): void {
    spaces.showDocument();
    if (selectedEntry?.kind === "command") selectedComponent = workspace.sidebarView;
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
  }

  function onWorkspaceShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || isCompositionKey(event) || workspace.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    if (
      event.key === "Escape" &&
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
<div class="app" data-reading-palette={palette} use:interactionFeedback use:paletteMotion={palette}>
  <VaultOpening {workspace} />
  <WindowToolbar
    bind:this={windowToolbar}
    {workspace}
    {filesCollapsed}
    {documentVisible}
    busy={changingSpace || workspace.switching || workspace.copying || workspace.isComposing}
    onToggleFiles={toggleFilesPane}
    onToggleSplit={() => void toggleSplit()}
    onPrepareDocumentAction={showDocumentTools}
  >
    {#snippet documentTools()}
      {#each workspace.panes as pane (pane.id)}
        {@const controls = paneControls.get(pane.id)}
        <div
          class="topbar-document"
          data-pane-tools={pane.id}
          hidden={!documentVisible || workspace.activePane !== pane}
        >
          {#if controls}{@render controls.toolbar()}{/if}
        </div>
      {/each}
    {/snippet}
  </WindowToolbar>
  <SettingsWindow
    bind:this={settingsWindow}
    {workspace}
    preferences={applicationMenu}
    onOpenVault={openVault}
  />
  <div class="panes">
    <button
      class="files-scrim"
      hidden={filesCollapsed || !narrow}
      inert={filesCollapsed || !narrow}
      type="button"
      aria-label="收起文件栏"
      onclick={closeFilesPane}
    ></button>
    <QuickNavigation
      bind:this={fileNavigation}
      {workspace}
      panel={sidebarPanel}
      activeEntry={selectedComponent}
      libraryShown={space === "library"}
      onNavigateDirectory={(path) => {
        fileList?.enterDirectory(path);
        if (narrow) closeFilesPane();
      }}
      onSelectPanel={(panel) => void selectSidebarPanel(panel)}
      hidden={filesCollapsed}
      width={leftWidth}
      onOpen={(path) => void openFile(path)}
      onCommand={executeCommand}
      canRun={(command) => commandAvailable(command, commandContext())}
      onSearchHit={(hit, match) => {
        const pane = workspace.activePane;
        void pane.navigation
          .openSearchMatch(hit, match ?? hit.matches[0], pane.openFile, (message) =>
            workspace.report(message),
          )
          .then(() => {
            if (pane.document.path === hit.path && workspace.activePane === pane)
              finishFileNavigation();
          });
      }}
      onWidth={(width) => {
        leftWidth = width;
        layoutWrites.request();
      }}
    >
      {#snippet header()}
        {#if !documentVisible}
          <button class="reader-button" type="button" onclick={() => void resumeWriting()}
            >← 返回文档</button
          >
        {/if}
      {/snippet}
      {#snippet documentTools()}
        {#each workspace.panes as pane (pane.id)}
          {@const controls = paneControls.get(pane.id)}
          <div
            class="sidebar-document"
            data-pane-tools={pane.id}
            hidden={!documentVisible || workspace.activePane !== pane}
          >
            {#if controls}{@render controls.outline()}{/if}
          </div>
        {/each}
      {/snippet}
      {#snippet footer()}
        <LinksDock
          {workspace}
          enabled={documentVisible}
          onOpenSettings={() => settingsWindow?.open()}
          onLink={(link) => {
            prepareDocumentAction();
            void workspace.openLink(link.kind, link.toRaw);
          }}
          onMention={(mention) => {
            prepareDocumentAction();
            const pane = workspace.activePane;
            void pane.navigation.openMention(mention, pane.openFile);
          }}
        />
      {/snippet}
    </QuickNavigation>
    <div
      class="content-space"
      use:sidebarMotion={{ collapsed: filesCollapsed, narrow }}
      bind:this={contentElement}
      tabindex="-1"
      inert={narrow && !filesCollapsed}
    >
      <div
        class="reading-space"
        data-motion="document"
        bind:this={readingSpace}
        hidden={!documentVisible}
        inert={!documentVisible}
        aria-hidden={!documentVisible}
        class:compact-split={compactSplit}
      >
        <div class="document-panes">
          {#each workspace.panes as pane (pane.id)}
            <PaneColumn
              {workspace}
              {pane}
              {registerControls}
              onShowTools={showDocumentTools}
              {mediaIo}
              hidden={compactSplit && workspace.activePane !== pane}
              narrowInert={narrow && !filesCollapsed}
              onRename={() => {
                workspace.activatePane(pane.id);
                beginRename();
              }}
            />
          {/each}
        </div>
      </div>
      <LibraryBrowser
        bind:this={fileList}
        onOpen={finishFileNavigation}
        {workspace}
        hidden={space !== "library"}
        onSearch={(query) => {
          workspace.setSearchInput(query);
          void searchFiles();
        }}
        readFile={readerApi.fileRead}
        onEdit={(action, entry, parent) => {
          if (action === "file") void startDocument("note", parent);
          else void entryDialog?.open(action, entry, parent);
        }}
        onNewWhiteboard={(parent) => void startDocument("whiteboard", parent)}
      />
    </div>
  </div>
  {#key workspace.exportScope}{#if workspace.exportScope !== null}<ExportDialog
        {workspace}
      />{/if}{/key}
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
  {#key pickerOpening}{#if picker === "switcher" || picker === "split"}
      <QuickSwitcher
        otherPane={picker === "split"}
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
  {/key}
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
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .panes {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: clip;
  }
  .content-space {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .reading-space {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .reading-space[hidden] {
    display: none;
  }
  .document-panes {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .document-panes :global(.pane-column + .pane-column) {
    border-left: 1px solid var(--border);
  }
  .sidebar-document[hidden] {
    display: none;
  }
  .files-scrim {
    display: none;
  }
  @media (max-width: 640px) {
    .files-scrim {
      display: block;
      position: absolute;
      inset: 0;
      border: 0;
      background: rgb(0 0 0 / 20%);
      z-index: 19;
    }
    .files-scrim[hidden] {
      display: none;
    }
    .panes :global(.file-sidebar) {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 20;
      max-width: calc(100% - 3rem);
    }
  }
</style>
