<script lang="ts">
  import ExportDialog from "./export/ExportDialog.svelte";
  import VaultOpening from "./workspace/VaultOpening.svelte";
  import { flushSync, onMount, tick, untrack, type Snippet } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import WindowToolbar from "./workspace/WindowToolbar.svelte";
  import SettingsWindow from "./workspace/SettingsWindow.svelte";
  import LinksDock from "./links/LinksDock.svelte";
  import LibraryBrowser from "./library/LibraryBrowser.svelte";
  import WorkspaceNavigation from "./navigation/WorkspaceNavigation.svelte";
  import Sidebar from "./library/Sidebar.svelte";
  import type { WorkspaceConversations } from "../shared/workspace-conversations";
  import PaneColumn from "./workspace/PaneColumn.svelte";
  import FileEntryDialog from "./library/FileEntryDialog.svelte";
  import CreateEntryDialog, { type CreateEntryKind } from "./library/CreateEntryDialog.svelte";
  import LinkCandidatesDialog from "./links/LinkCandidatesDialog.svelte";
  import DeadLinkDialog from "./links/DeadLinkDialog.svelte";
  import QuickSwitcher from "./navigation/QuickSwitcher.svelte";
  import CommandPalette from "./workspace/CommandPalette.svelte";
  import type { PaneControls } from "./workspace/pane-controls";
  import { parentDirectory, type FileEntryChange } from "./library/file-tree";
  import { ReaderWorkspaceController } from "./workspace/state.svelte";
  import { SIDEBAR_LAYOUT, type ReaderApi, type PaneLayout } from "../shared/api";
  import "./styles/controls.css";
  import "./styles/motion.css";
  import { interactionFeedback, revealOnChange } from "./motion";
  import { paletteMotion } from "./palette-motion";
  import type { HistoryAction, HistoryAvailability } from "../shared/api";
  import {
    commandAvailable,
    commandForKey,
    type CommandContext,
    type ReaderCommand,
  } from "../shared/commands";
  import { isCompositionKey } from "../shared/composition";
  import { createSessionWrite } from "./session-write";
  import { READING_FONTS, type ReadingFont } from "../shared/reading-font";
  import { DEFAULT_READING_PALETTE, type ReadingPalette } from "../shared/reading-palette";
  import type { SelectedContent } from "../shared/selected-content";
  import type { SelectionSource } from "../shared/selected-content";
  import type { ArticleAgentActions } from "../shared/article-conversations";

  /** 每次挂载对应一个阅读器实例，api 在该实例存活期间保持不变。 */
  let {
    api,
    applicationMenu,
    modelPreferences,
    beforeModelLeave,
    palette = DEFAULT_READING_PALETTE,
    agentOpen = false,
    onOpenAgent,
    articleAgent,
    onAddReference,
    conversations,
    agentPanel,
    onCommand,
  }: {
    api: ReaderApi;
    applicationMenu: Snippet;
    modelPreferences?: Snippet;
    beforeModelLeave?: () => Promise<boolean>;
    /** 配色只影响样式变量，不重建文档或修改阅读位置。 */
    palette?: ReadingPalette;
    agentOpen?: boolean;
    onOpenAgent?: () => void;
    articleAgent?: ArticleAgentActions;
    onAddReference?: (reference: SelectedContent) => Promise<void>;
    conversations?: WorkspaceConversations;
    agentPanel?: Snippet;
    onCommand?: (command: ReaderCommand) => void;
  } = $props();
  // 控制器和资源访问接口共用同一组能力，替换能力时由外壳重新挂载实例。
  const readerApi = untrack(() => api);
  const workspace = new ReaderWorkspaceController(readerApi, async (root, changes) => {
    await articleAgent?.api.remapArticles(root, changes);
  });
  $effect(() => {
    const root = workspace.vaultRoot;
    if (root && articleAgent)
      void articleAgent.api.attachVault(root).catch((error) => workspace.report(String(error)));
  });
  const mediaIo = workspace.mediaIo;
  // 活动栏文档：命令门禁与重命名等操作的目标随活动栏切换。
  const doc = $derived(workspace.document);
  let filesCollapsed = $state(false);
  let sidebarPanel = $state<"files" | "outline">("files");
  let readingSpace: HTMLDivElement | undefined = $state();
  let creatingDocument = false;
  let narrow = $state(false);
  const drawerOpen = $derived(narrow && !filesCollapsed);
  let rightWidth = $state(380);
  $effect(() => {
    void conversations?.selected;
    if (agentOpen && narrow)
      untrack(() => {
        filesCollapsed = true;
        layoutWrites.request();
      });
  });
  const sidebarId = $props.id();
  let leftWidth = $state(SIDEBAR_LAYOUT.leftWidth);
  const layoutWrites = createSessionWrite({
    delayMs: 300,
    write: async (isCurrent) => {
      if (isCurrent())
        await readerApi.sessionSetPanes({
          filesCollapsed,
          leftWidth,
          destination: "document",
          sidebarView: sidebarPanel,
          rightWidth,
        });
    },
    report: reportLayoutFailure,
  });
  let entryDialog: FileEntryDialog | undefined = $state();
  let createDialog: CreateEntryDialog | undefined = $state();
  let fileList: LibraryBrowser | undefined = $state();
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
  const documentVisible = true;
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
    if (workspace.isComposing || workspace.switching) return true;
    if (document.querySelector("dialog[open]")) return false;
    return workspace.navigation.applyHistory(action);
  }

  /** 与执行门禁一致的响应式历史投影；null 交由外壳查询当前原生输入控件。 */
  export function historyAvailability(): HistoryAvailability | null {
    if (!documentVisible) return null;
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
        void startDocument("directory");
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
        sidebarPanel =
          restoredSpace.sidebarView === "outline" && restoredSpace.destination !== "library"
            ? "outline"
            : "files";
        if (
          restoredSpace.searchQuery &&
          (!workspace.fileTree.hasStoredState || workspace.fileTree.state.browse === undefined)
        )
          workspace.fileTree.setQuery(restoredSpace.searchQuery);
      }
    })();
    return () => {
      mounted = false;
      observer.disconnect();
      layoutWrites.dispose();
      dispose();
    };
  });

  async function restorePanes(): Promise<PaneLayout> {
    try {
      const panes = await readerApi.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
      rightWidth = panes.rightWidth ?? 380;
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

  async function showLibrary(): Promise<void> {
    sidebarPanel = "files";
    filesCollapsed = false;
    persistPanes();
    await tick();
    await fileList?.focusSearch();
  }
  async function openVault(): Promise<void> {
    await importDirectory("");
  }

  async function importDirectory(parent: string): Promise<void> {
    const imported = await workspace.importDirectory(parent);
    if (imported !== null) {
      sidebarPanel = "files";
      filesCollapsed = false;
      persistPanes();
      await fileList?.reflectChange(
        { action: "create", entry: { path: imported.path, kind: "directory" } },
        true,
      );
    }
  }

  /** 新建跟随明确选中的目录或文件父目录；缺失父目录回到最近的现有层级。 */
  function creationDirectory(): string {
    const selected = workspace.fileTree.state.selected;
    const path = selected.length === 1 ? selected[0] : workspace.document.path;
    const entry = workspace.entries.find((entry) => entry.path === path);
    let directory = entry?.kind === "directory" ? entry.path : parentDirectory(path ?? "");
    while (
      directory &&
      !workspace.entries.some((entry) => entry.kind === "directory" && entry.path === directory)
    )
      directory = parentDirectory(directory);
    return directory;
  }

  /** 创建入口只准备可确认的表单；目录操作的明确位置优先于默认建议。 */
  async function startDocument(
    kind: CreateEntryKind,
    parentOverride?: string,
    suggestedName?: string,
  ): Promise<void> {
    if (creatingDocument || workspace.isComposing) return;
    creatingDocument = true;
    try {
      if (workspace.vaultRoot === null) await workspace.openVault("default");
      if (workspace.vaultRoot === null) return;
      await createDialog?.open(kind, parentOverride ?? creationDirectory(), suggestedName);
    } catch (error) {
      workspace.report(error instanceof Error ? error.message : String(error));
    } finally {
      creatingDocument = false;
    }
  }

  function updateViewport(): void {
    narrow = window.innerWidth <= 640;
  }

  function closeFilesPane(): void {
    const focus = document.activeElement;
    const returnFocus =
      focus instanceof Element && focus.closest(".file-sidebar:not(.right), .files-scrim") !== null;
    filesCollapsed = true;
    persistPanes();
    // 只接回即将隐藏的控件焦点；快捷键收起侧栏时，正文继续接收输入。
    if (returnFocus) void tick().then(() => windowToolbar?.focusSidebarToggle());
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
    if (workspace.switching || workspace.copying || workspace.isComposing) return;
    if (workspace.split) {
      const other = workspace.panes.find((pane) => pane !== workspace.activePane);
      if (other) await workspace.closePane(other.id);
    } else openPicker("split");
  }

  function showDocumentTools(): void {
    workspace.navigation.cancelPositionRestore();
    prepareDocumentAction();
  }

  function selectSidebarPanel(panel: "files" | "outline"): void {
    if (workspace.isComposing) return;
    sidebarPanel = panel;
    persistPanes();
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
  }

  function finishFileNavigation(focus = true): void {
    if (focus || narrow) focusDocument();
  }

  /** 外壳解除正文 inert 后交还键盘焦点，保留原段落选区。 */
  export function focusDocument(): void {
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
    await fileList?.reflectChange(change, sidebarPanel === "files" && !filesCollapsed && !writing);
    if (writing) finishFileNavigation();
  }

  function onWorkspaceShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || isCompositionKey(event) || workspace.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    if (
      event.key === "Escape" &&
      drawerOpen &&
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
      if (onCommand) onCommand(command);
      else executeCommand(command);
    }
  }

  /** @returns 当前编辑已安全保存时允许关闭；冲突或写入失败时由应用外壳保留窗口。 */
  export async function flushBeforeClose(): Promise<boolean> {
    if ((await settingsWindow?.confirmLeave()) === false) return false;
    try {
      await layoutWrites.flush();
    } catch (error) {
      reportLayoutFailure(error);
      return false;
    }
    return workspace.flushBeforeClose();
  }

  /** 对话中的配置入口复用唯一设置窗口，并定位到 LLM 分类，不重建对话。 */
  export function openModelSettings(): void {
    settingsWindow?.open("models");
  }

  /** 当前已提交的笔记库，用于外壳判断是否能在现有工作台定位文章。 */
  export function vaultRoot(): string | null {
    return workspace.vaultRoot;
  }

  /**
   * @param source 显式引用的文件来源，不改变对话的文件或目录关联。
   * @returns 文档保存门禁完成、来源打开并核对原文位置后兑现。
   * @throws 来源不属于当前笔记库、文件移除、保存未完成或原文已失效时拒绝。
   */
  export async function openReference(source: SelectionSource): Promise<void> {
    if (source.root !== workspace.vaultRoot)
      throw new Error(`请先打开引用所属的笔记库：${source.root}`);
    if (!workspace.files.includes(source.path)) throw new Error("引用来源已移除，引用原文仍保留");
    await workspace.openFile(source.path);
    if (workspace.document.path !== source.path)
      throw new Error("来源切换未完成，请先处理保存问题");
    finishFileNavigation();
    await tick();
    workspace.navigation.selectReference(source);
  }

  /** 从文章对话返回稳定入口；跨库或来源已移除时明确报错，不打开错误文章。 */
  export async function openArticle(root: string, path: string, markerId: string): Promise<void> {
    if (root !== workspace.vaultRoot) throw new Error(`请先打开此对话所属的笔记库：${root}`);
    if (!workspace.files.includes(path)) throw new Error("来源文章已移除，对话历史仍保留");
    await workspace.openFile(path);
    if (workspace.document.path !== path) throw new Error("文章切换未完成，请先处理保存问题");
    if (workspace.viewMode === "source") await workspace.toggleViewMode();
    finishFileNavigation();
    if (markerId)
      await workspace.navigation.openConversation(path, markerId, workspace.openFile, () =>
        workspace.report("文章已打开，但未找到唯一的对话入口；请检查入口是否被移除或重复"),
      );
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
    {agentOpen}
    {...onOpenAgent === undefined ? {} : { onOpenAgent }}
    bind:this={windowToolbar}
    {workspace}
    {filesCollapsed}
    {documentVisible}
    busy={workspace.switching || workspace.copying || workspace.isComposing}
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
    {...modelPreferences === undefined ? {} : { modelPreferences }}
    {...beforeModelLeave === undefined ? {} : { beforeModelLeave }}
    onOpenVault={openVault}
  />
  <div class="panes">
    <button
      class="files-scrim"
      hidden={!drawerOpen}
      inert={!drawerOpen}
      type="button"
      aria-label="收起文件栏"
      onclick={closeFilesPane}
    ></button>
    <Sidebar
      width={leftWidth}
      hidden={filesCollapsed}
      onWidth={(width) => {
        leftWidth = width;
        layoutWrites.request();
      }}
    >
      <WorkspaceNavigation
        {sidebarId}
        selected={sidebarPanel}
        disabled={workspace.switching || workspace.isComposing}
        onSelect={selectSidebarPanel}
        onCreate={(kind) => void startDocument(kind)}
        {...conversations
          ? {
              onConversation: () => {
                const root = workspace.vaultRoot;
                const parent = creationDirectory();
                void conversations
                  .create(root ? `${root}${parent ? `/${parent}` : ""}` : "")
                  .catch((error) => workspace.report(String(error)));
              },
            }
          : {}}
      />
      <div
        id={`${sidebarId}-files`}
        class="sidebar-content library"
        role="region"
        aria-label="笔记库"
        hidden={sidebarPanel !== "files"}
        use:revealOnChange={{
          key: sidebarPanel,
          kind: "navigation",
          direction: sidebarPanel === "files" ? -1 : 1,
        }}
      >
        <LibraryBrowser
          {workspace}
          {...conversations ? { conversations } : {}}
          bind:this={fileList}
          hidden={filesCollapsed || sidebarPanel !== "files"}
          onOpen={finishFileNavigation}
          onEdit={(action, entry, parent) => {
            if (action === "file") void startDocument("note", parent);
            else if (action === "directory") void startDocument("directory", parent);
            else if (action === "whiteboard") void startDocument("whiteboard", parent);
            else if (action === "import") void importDirectory(parent);
            else void entryDialog?.open(action, entry, parent);
          }}
        />
      </div>
      <div
        id={`${sidebarId}-outline`}
        class="sidebar-content outline-content"
        role="region"
        aria-label="目录"
        hidden={sidebarPanel !== "outline"}
        use:revealOnChange={{
          key: sidebarPanel,
          kind: "navigation",
          direction: sidebarPanel === "files" ? -1 : 1,
        }}
      >
        {#each workspace.panes as pane (pane.id)}
          {@const controls = paneControls.get(pane.id)}
          <div
            class="sidebar-document"
            data-pane-tools={pane.id}
            hidden={workspace.activePane !== pane}
          >
            {#if controls}{@render controls.outline()}{/if}
          </div>
        {/each}
      </div>
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
    </Sidebar>
    <div
      class="content-space"
      bind:this={contentElement}
      tabindex="-1"
      inert={drawerOpen}
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
              {...articleAgent ? { articleAgent } : {}}
              {...onAddReference ? { onAddReference } : {}}
              {workspace}
              {pane}
              {registerControls}
              onShowTools={showDocumentTools}
              {mediaIo}
              sidebarLayout={{ collapsed: filesCollapsed, narrow, agentOpen }}
              hidden={compactSplit && workspace.activePane !== pane}
              narrowInert={drawerOpen}
              onRename={() => {
                workspace.activatePane(pane.id);
                beginRename();
              }}
            />
          {/each}
        </div>
      </div>
    </div>
    {#if agentPanel}<Sidebar
        side="right"
        width={rightWidth}
        minWidth={320}
        maxWidth={640}
        defaultWidth={380}
        hidden={!agentOpen}
        onWidth={(width) => {
          rightWidth = width;
          layoutWrites.request();
        }}
      >
        {@render agentPanel()}
      </Sidebar>{/if}
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
  <CreateEntryDialog
    bind:this={createDialog}
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
        onCreate={(path) =>
          void startDocument(
            "note",
            path.includes("/") ? parentDirectory(path) : undefined,
            path.split("/").at(-1),
          )}
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
  .sidebar-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .outline-content {
    overflow: auto;
  }
  .sidebar-content[hidden] {
    display: none;
  }

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
    .panes :global(.file-sidebar:not(.right)) {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 20;
      max-width: calc(100% - 3rem);
    }
  }
</style>
