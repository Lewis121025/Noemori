import { tick } from "svelte";
import type { ShapeRepair } from "../../shared/whiteboard/recognition";
import type { VaultOpenProgress } from "../../shared/vault-opening";
import type {
  ExportFormat,
  ExportRequest,
  ExportResult,
  ExportProgress,
  ExportPlan,
} from "../../shared/export";
import { parseReadingBookmark } from "../../shared/reading-position";
import type {
  NoteKeys,
  ReaderApi,
  VaultEntry,
  RenameOutcome,
} from "../../shared/api";
import type { DeadLinkOffer } from "../links/dead-link";
import type { AttachmentImporter } from "../../shared/attachments";
import { deadLinkSeed } from "../links/dead-link";
import {
  mapPathList,
  mapViewModes,
  pushRecentFile,
  type PaneSession,
  type ViewModes,
} from "../../shared/session";
import { ReaderPane, type PaneHost, type ViewMode } from "./pane.svelte";
import type { ReaderHistory } from "../navigation/history.svelte";
import { ReaderSearch } from "../search/state.svelte";
import { createBrowserMediaIo, type MediaIo } from "../preview/media";
import { ReaderFileTree } from "../library/state.svelte";
import { createSessionWrite, type SessionWrite } from "../session-write";
import {
  mapEntryPath,
  type EntryBatchRequest,
  type EntryBatchProgress,
  type EntryBatchResult,
} from "../../shared/entry-batch";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const READING_SESSION_ERROR =
  "阅读现场未能保存，下次打开可能无法恢复当前位置。请检查文件权限后重试。";

/** 成功反馈只属于产生它的分栏与文档版本；需要处理的错误不随输入自动消失。 */
type WorkspaceNotice =
  | { kind: "attention"; source: "operation" | "save"; message: string; detail: string }
  | { kind: "confirmation"; message: string; paneId: number; epoch: number; revision: number };

/**
 * 工作区协调器：拥有笔记库、文件列表、消息与会话，文档状态按分栏持有。
 *
 * 每个分栏（ReaderPane）是一份完整的可编辑文档面：自己的门禁、保存与
 * 阅读栈。「当前文档」语义由活动栏承担——侧栏、工具栏与命令都作用于它；
 * 链接点击与提及跳转则回到发起动作的那一栏。所有离开文档的操作先冲刷
 * 保存；监视事件在切换或写盘结束后重新读取。
 */
export class ReaderWorkspaceController {
  /** 导出弹层的明确范围，打开后不跟随文件栏的后续选择变化。 */
  exportScope = $state.raw<ExportRequest["scope"] | null>(null);
  private exportRunning = false;
  private exportStarted = false;
  private exportStopBeforeStart = false;

  /** 打开导出设置；空选择和未开库没有导出对象。 */
  requestExport(scope: ExportRequest["scope"]): void {
    if (
      this.root === null ||
      this.exportRunning ||
      this.composing ||
      (scope.kind === "selection" && scope.paths.length === 0)
    )
      return;
    this.exportScope =
      scope.kind === "vault" ? { kind: "vault" } : { kind: "selection", paths: [...scope.paths] };
  }

  /**
   * 全栏保存及附件结算完成后才进入导出；取消不会撤销已经成功的前置保存。
   * @returns 未保存、冲突和执行失败均有明确结果，原始编辑继续保留。
   */
  async runExport(
    format: ExportFormat,
    progress: (value: ExportProgress) => void,
    plan: (value: ExportPlan) => void,
  ): Promise<ExportResult> {
    const scope = this.exportScope;
    const root = this.root;
    if (root === null || scope === null || this.exportRunning)
      return {
        status: "failed",
        issues: [{ path: "", severity: "error", message: "当前没有可执行的导出选择" }],
      };
    this.exportRunning = true;
    this.exportStopBeforeStart = false;
    progress({ phase: "saving", completed: 0, total: null, path: null });
    try {
      const result = await this.withAllPanesSaved(async () => {
        if (this.exportStopBeforeStart) return { status: "cancelled" } as const;
        if (root !== this.root) throw new Error("笔记库已切换，请重新导出");
        this.exportStarted = true;
        return this.api.exportRun({ root, scope, format }, progress, plan);
      });
      return (
        result ?? {
          status: "failed",
          issues: [
            {
              path: "",
              severity: "error",
              message: "请先完成输入、附件导入并处理保存冲突，然后重新导出",
            },
          ],
        }
      );
    } catch (error) {
      return {
        status: "failed",
        issues: [{ path: "", severity: "error", message: errorText(error) }],
      };
    } finally {
      this.exportRunning = false;
      this.exportStarted = false;
    }
  }

  /** 提交边界前请求停止，保存门禁仍运行时阻止随后创建原生任务。 */
  async cancelExport(): Promise<boolean> {
    if (!this.exportRunning) return false;
    if (!this.exportStarted) {
      this.exportStopBeforeStart = true;
      return true;
    }
    return this.api.exportCancel();
  }

  /** 显示当前窗口最后一次成功的导出结果，失败时保留可见原因。 */
  async revealExport(): Promise<void> {
    try {
      await this.api.exportReveal();
    } catch (error) {
      this.report(`无法显示导出结果：${errorText(error)}`);
    }
  }
  /** 全库搜索；结果属于当前库，切库必须丢弃。 */
  readonly search: ReaderSearch;
  /** 所有阅读与预览表面共用同一库内资源访问能力。 */
  readonly mediaIo: MediaIo;
  private openingOther = false;
  /** 文件树的跨重启现场，文件操作与外部清单刷新均经此迁移。 */
  readonly fileTree: ReaderFileTree;
  /** 可编辑分栏，1–2 个；下标即栏位，永不为空。 */
  private paneList = $state<ReaderPane[]>([]);
  private activeId = $state(0);
  private paneSeq = 1;
  /** 会话内按文件记住源码视图，随会话持久化。非响应式记录表。 */
  private readonly viewModes: ViewModes = {};
  /** 最近打开的文件，最新在前；跨栏共享，随会话持久化。 */
  private recent = $state<string[]>([]);
  /** 笔记标题与别名；每次目录刷新后更新，供别名补全同步读取。 */
  private keys = $state.raw<NoteKeys[]>([]);
  /** 笔记身份读取的请求序号；只有最新一次的结果生效。 */
  private keysRequest = 0;
  private root = $state<string | null>(null);
  private opening = $state<VaultOpenProgress | null>(null);
  private openGeneration = 0;
  private stoppingOpen = $state(false);
  private listed = $state<VaultEntry[]>([]);
  /** 目录刷新次数；每次库变更后递增，资料预览据此重读索引。 */
  private revision = $state(0);
  private filePaths = $derived(
    this.listed.filter((entry) => entry.kind === "file").map((entry) => entry.path),
  );
  private notice = $state<WorkspaceNotice | null>(null);
  /** 会话失败独立于操作结果；成功加载或保存正文不能证明这次会话写入已恢复。 */
  private sessionNotice = $state<WorkspaceNotice | null>(null);
  private backgroundError = $state("");
  private composing = $state(false);
  private candidateSelection = $state<{
    paths: string[];
    anchor: string | null;
    paneId: number;
  } | null>(null);
  /** 死链可以创建的笔记与发起栏；`null` 表示没有等待确认的创建。 */
  private deadLink = $state<{ offer: DeadLinkOffer; paneId: number } | null>(null);
  private refreshEpoch = 0;
  /** 目录快照的世代：切库或恢复重启时递增，过期列表结果直接丢弃。 */
  private listGeneration = 0;
  private listRequest = 0;
  private pendingRefresh = false;
  private idleWaiters: Array<() => void> = [];
  private compositionWaiters: Array<() => void> = [];
  private readonly host: PaneHost;
  private readonly documentSession: SessionWrite;

  /** 当前一笔的后台几何修复；文档、预览和撤销仍由白板输入状态机负责。 */
  repairWhiteboard: ShapeRepair = (request) => this.api.whiteboardRepair(request);

  /** @param api 外壳注入的阅读器能力；构造不订阅事件，挂载时由 start 订阅。 */
  constructor(
    private readonly api: ReaderApi,
    private readonly onEntriesChanged?: (
      root: string,
      changes: { from: string; to: string | null }[],
    ) => Promise<void>,
  ) {
    this.documentSession = createSessionWrite({
      delayMs: 300,
      write: (isCurrent) => this.writeDocuments(isCurrent),
      ready: () => !this.composing && this.paneList.every((pane) => pane.idle),
      report: (error) => this.reportSessionFailure(READING_SESSION_ERROR, error),
    });
    this.mediaIo = createBrowserMediaIo(api);
    this.search = new ReaderSearch(api, (message) => this.report(message));
    this.fileTree = new ReaderFileTree(
      () => this.root,
      (root, state) => api.sessionSetFileTree(root, state),
      (message) => this.report(message),
    );
    // 对象字面量的 getter 里 this 指向 host 自身，用闭包读工作区实时状态。
    const vaultRoot = () => this.root;
    const composing = () => this.composing;
    this.host = {
      get vaultRoot() {
        return vaultRoot();
      },
      get composing() {
        return composing();
      },
      waitComposition: () => this.waitComposition(),
      report: (message, error) => this.report(message, error),
      reportIfQuiet: (message) => {
        if (this.message === "") this.report(message);
      },
      announce: (pane, message) => this.announceFor(pane, message),
      noticeSaveWarning: (warning) => this.noticeSaveWarning(warning),
      noticeSaveBlocked: (pane) => {
        this.notice = {
          kind: "attention",
          source: "save",
          message: `「${pane.document.path}」尚未保存，请通过“处理保存问题”处理后重试。`,
          detail: "",
        };
      },
      offerDeadLink: (pane, offer) => {
        this.deadLink = { offer, paneId: pane.id };
      },
      offerCandidates: (pane, paths, anchor) => {
        this.candidateSelection = { paths, anchor, paneId: pane.id };
      },
      noteOpened: (path) => {
        this.recent = pushRecentFile(this.recent, path);
        this.persistRecentFiles();
      },
      settlePath: async (path) => {
        for (const pane of this.paneList)
          if (pane.document.path === path && !(await pane.flushBeforeLeave())) return false;
        return true;
      },
      viewModeOf: (path) => (Object.hasOwn(this.viewModes, path) ? this.viewModes[path]! : null),
      setViewMode: (path, mode) => {
        if (mode === null) delete this.viewModes[path];
        else this.viewModes[path] = mode;
        this.persistViewModes();
      },
      persistDocuments: () => this.persistDocuments(),
      rememberDocuments: () => this.persistDocumentsSafe(),
      scheduleReadingPosition: () => this.documentSession.request(),
      refreshList: () => this.refreshList(),
      resumeVaultRefresh: () => this.resumeVaultRefresh(),
      onPaneIdle: () => {
        this.documentSession.resume();
        if (this.paneList.every((pane) => pane.idle)) this.notifyIdle();
      },
    };
    // 启动门禁：restore 完成前界面保持 inert。
    this.paneList = [new ReaderPane(0, api, this.host, true)];
    this.activeId = 0;
  }

  /** 当前库根路径。 */
  get vaultRoot() {
    return this.root;
  }
  /** 当前开库准备的真实阶段；null 表示没有进行中的打开。 */
  get openingProgress() {
    return this.opening;
  }
  /** 已请求协作取消，等待当前安全边界返回。 */
  get cancellingOpen() {
    return this.stoppingOpen;
  }

  /** 取消只作用于当前打开；提交赢得边界后由成功结果完成界面切换。 */
  cancelOpening = async (): Promise<void> => {
    if (this.opening === null || this.stoppingOpen || this.opening.phase === "committing") return;
    const generation = this.openGeneration;
    this.stoppingOpen = true;
    try {
      const cancelled = await this.api.vaultOpenCancel();
      if (generation === this.openGeneration && !cancelled) this.stoppingOpen = false;
    } catch (error) {
      if (generation === this.openGeneration) {
        this.stoppingOpen = false;
        this.report("取消打开未能完成，请重试。", error);
      }
    }
  };

  private beginOpening() {
    const generation = ++this.openGeneration;
    this.opening = { phase: "preparing", completed: 0, total: null };
    this.stoppingOpen = false;
    return {
      report: (progress: VaultOpenProgress) => {
        if (generation === this.openGeneration) this.opening = progress;
      },
      finish: () => {
        if (generation !== this.openGeneration) return;
        this.openGeneration += 1;
        this.opening = null;
        this.stoppingOpen = false;
      },
    };
  }
  /** 当前库的文件列表。 */
  get files() {
    return this.filePaths;
  }
  /** 包含空文件夹的目录快照。 */
  get entries() {
    return this.listed;
  }
  /** 索引版本：每次目录刷新（打开库、保存、外部变更、改名）后递增。 */
  get indexRevision(): number {
    return this.revision;
  }
  /** 最近打开的文件，最新在前；可能包含已被外部删除的路径，由使用方按文件列表过滤。 */
  get recentFiles(): readonly string[] {
    return this.recent;
  }
  /** 最近一次目录刷新时的笔记标题与别名；索引不可用时为空。 */
  get noteKeys(): readonly NoteKeys[] {
    return this.keys;
  }
  /** 全部分栏；界面按序渲染。 */
  get panes(): readonly ReaderPane[] {
    return this.paneList;
  }
  /** 活动分栏；「当前文档」语义的承担者。 */
  get activePane(): ReaderPane {
    // paneList 永不为空：关栏只在分栏时发生，切库整体替换为新单栏。
    return this.paneList.find((pane) => pane.id === this.activeId) ?? this.paneList[0]!;
  }
  /** 是否分栏显示。 */
  get split(): boolean {
    return this.paneList.length > 1;
  }
  /** 当前操作错误优先展示；普通确认不能覆盖尚未确认的会话故障。 */
  private get visibleNotice(): WorkspaceNotice | null {
    return this.notice?.kind === "attention" ? this.notice : (this.sessionNotice ?? this.notice);
  }
  /** 文件操作的结果提示。 */
  get message() {
    const notice = this.visibleNotice;
    if (notice === null) return "";
    if (notice.kind === "confirmation") {
      const pane = this.paneById(notice.paneId);
      if (
        pane === undefined ||
        pane.id !== this.activePane.id ||
        notice.epoch !== pane.document.epoch ||
        notice.revision !== pane.document.editRevision
      )
        return "";
    }
    return notice.message;
  }
  /** 操作错误与警告使用明确提示；普通成功消息不抢占辅助技术的即时播报。 */
  get messageNeedsAttention() {
    return this.visibleNotice?.kind === "attention";
  }
  /** 技术详情仅在用户展开后显示；即时播报只包含影响和处理建议。 */
  get messageDetail() {
    const notice = this.visibleNotice;
    return notice?.kind === "attention" ? notice.detail : "";
  }
  /** 后台失败单独展示，不能被普通文件操作或成功保存抹掉。 */
  get healthMessage() {
    return this.backgroundError;
  }

  // —— 活动栏委托：外壳与测试面向「当前文档」的既有入口保持不变。——

  /** 活动栏文档。 */
  get document() {
    return this.activePane.document;
  }
  /** 活动栏导航（大纲、引用与定位）。 */
  get navigation() {
    return this.activePane.navigation;
  }
  /** 活动栏阅读栈。 */
  get history() {
    return this.activePane.history;
  }
  /** 活动栏 Markdown 视图模式。 */
  get viewMode(): ViewMode {
    return this.activePane.viewMode;
  }
  /** 活动栏切换期间界面禁止编辑。 */
  get switching(): boolean {
    return this.activePane.switching;
  }
  /** 活动栏副本写入中。 */
  get copying(): boolean {
    return this.activePane.copying;
  }
  get openFile() {
    return this.activePane.openFile;
  }
  get openLink() {
    return this.activePane.openLink;
  }
  get navigateBack() {
    return this.activePane.navigateBack;
  }
  get navigateForward() {
    return this.activePane.navigateForward;
  }
  get toggleViewMode() {
    return this.activePane.toggleViewMode;
  }
  get markDirty() {
    return this.activePane.markDirty;
  }
  get requestSave() {
    return this.activePane.requestSave;
  }
  get saveCopy() {
    return this.activePane.saveCopy;
  }
  get suggestHeadings() {
    return this.activePane.suggestHeadings;
  }
  get linkifyMention() {
    return this.activePane.linkifyMention;
  }
  /** 捕获活动栏文档的附件导入器。 */
  captureAttachmentImporter(): AttachmentImporter {
    return this.activePane.captureAttachmentImporter();
  }

  /** 组词期间允许继续编辑，但暂停提交、离开文档与外部重载。 */
  get isComposing() {
    return this.composing;
  }

  /** @param active 原生输入法是否仍持有未确认的候选文本。结束后重新计时并恢复外部刷新。 */
  setComposing(active: boolean): void {
    if (active === this.composing) return;
    this.composing = active;
    if (active) for (const pane of this.paneList) pane.pauseAutosave();
    else {
      const waiters = this.compositionWaiters;
      this.compositionWaiters = [];
      for (const resolve of waiters) resolve();
      for (const pane of this.paneList) pane.resumeAutosave();
      this.documentSession.resume();
      this.resumeVaultRefresh();
    }
  }

  /** 等待组词结束；副本写入等长操作跨越组词时用它串行化。 */
  async waitComposition(): Promise<void> {
    while (this.composing)
      await new Promise<void>((resolve) => this.compositionWaiters.push(resolve));
  }

  /**
   * @param message 布局等操作的影响与处理建议；空字符串表示清除操作消息。
   * @param error 可选原始错误，保留在可展开详情中，不混入即时播报。
   */
  report(message: string, error?: unknown): void {
    this.notice =
      message === ""
        ? null
        : {
            kind: "attention",
            source: "operation",
            message,
            detail: error === undefined ? "" : errorText(error),
          };
  }

  /** 只确认当前展示的消息；尚未展示的会话故障和后台状态仍保留。 */
  dismissMessage = (): void => {
    if (this.visibleNotice === this.sessionNotice) this.sessionNotice = null;
    else this.notice = null;
  };

  /** 操作完成后的轻量确认；随当前文档变化失效，不使用错误提示样式。 */
  announce(message: string): void {
    this.announceFor(this.activePane, message);
  }

  private announceFor(pane: ReaderPane, message: string): void {
    this.notice =
      message === ""
        ? null
        : {
            kind: "confirmation",
            message,
            paneId: pane.id,
            epoch: pane.document.epoch,
            revision: pane.document.editRevision,
          };
  }

  private noticeSaveWarning(warning: string | null): void {
    if (warning !== null)
      this.notice = {
        kind: "attention",
        source: "save",
        message: `本次内容已保存。${warning}`,
        detail: "",
      };
    // 正文提交只清理保存自身的消息，不能把布局或会话失败误当成已解决。
    else if (this.notice?.kind !== "attention" || this.notice.source === "save") this.notice = null;
  }

  /**
   * 挂载时订阅笔记库变更；每个控制器只能由所属工作区挂载一次。
   * @returns 卸载清理函数，取消计时和监视订阅。
   */
  start(): () => void {
    const unsubscribe = this.api.subscribeVaultChanged((event) => {
      // 检索结果的版本立即失效，不能等输入法、写盘或正文重载的门禁释放。
      this.search.markStale();

      if (event.status === "changed") {
        if (event.healthy) this.backgroundError = "";
        void this.onVaultChanged();
      } else {
        const impact =
          event.status === "worker-error"
            ? "内核已停止，无法继续保存。请保留窗口并复制尚未保存的内容，再重启应用。"
            : event.status === "watch-error"
              ? "文件监视中断，外部修改可能不会及时出现。请重新打开笔记库。"
              : "索引刷新失败，检索和引用可能过期；正文仍可保存。请检查文件权限后重新打开笔记库。";
        this.backgroundError = `${impact} ${event.message}`;
      }
    });
    return () => {
      this.documentSession.dispose();
      this.search.reset();

      this.fileTree.reset();
      for (const pane of this.paneList) pane.dispose();
      unsubscribe();
    };
  }

  /** 恢复上次笔记库、分栏与文档；失败显示原因，最终释放启动门禁。 */
  async restore(): Promise<void> {
    this.documentSession.reset();
    const opening = this.beginOpening();
    try {
      const restored = await this.api.vaultRestore(opening.report);
      if (restored === null) return;
      this.root = restored.root;
      this.search.reset();

      this.publishEntries(restored.entries);
      // 视图记忆先于打开文档装表，loadFile 才能按记忆恢复视图。
      this.clearViewModes();
      Object.assign(this.viewModes, restored.viewModes);
      this.recent = restored.recentFiles.filter((path) => this.files.includes(path));
      // 按会话恢复分栏；启动栏复用（保持门禁），第二栏按需补建。
      const sessions = restored.documents.panes;
      this.listGeneration += 1;
      while (this.paneList.length < sessions.length && this.paneList.length < 2)
        this.paneList = [
          ...this.paneList,
          new ReaderPane(this.paneSeq++, this.api, this.host, true),
        ];
      const activeIndex = Math.min(restored.documents.active, this.paneList.length - 1);
      this.activeId = this.paneList[activeIndex]!.id;
      // 阅读栈按当前文件列表过滤；已删除文件的条目不再误导导航。
      const files = this.files;
      for (const [index, pane] of this.paneList.entries()) {
        const session: PaneSession = sessions[index] ?? {
          currentPath: null,
          history: { back: [], forward: [] },
        };
        pane.outlineCollapsed = session.outlineCollapsed ?? false;
        pane.history.restore(session.history, (path) => files.includes(path));
        if (session.currentPath !== null && files.includes(session.currentPath)) {
          await pane.loadFile(session.currentPath, false, session.position);
          // 初始落点不入栈：与浏览器一致，恢复的起点没有「上一步」。
          pane.currentStep = { path: session.currentPath, anchor: null };
        } else {
          pane.currentStep = null;
        }
      }
      await this.persistDocumentsSafe();
      this.fileTree.restore(restored.fileTree, this.listed);
    } catch (error) {
      this.report(error instanceof Error ? error.message : "恢复会话失败");
    } finally {
      opening.finish();
      for (const pane of this.paneList) pane.finishTransition();
      void this.api
        .exportRecover()
        .catch((error: unknown) => this.report(`上次导出结果检查失败：${errorText(error)}`));
    }
  }

  /** 打开用户选择的库；取消选择、冲突或保存失败时保留原库与编辑。 */
  openVault = async (kind: "choose" | "default" = "choose"): Promise<void> => {
    try {
      await this.withAllPanesSaved(async () => {
        await this.flushPendingDocuments();
        const opening = this.beginOpening();
        try {
          const opened =
            kind === "default"
              ? await this.api.vaultCreateDefault(opening.report)
              : await this.api.vaultOpen(opening.report);
          if (opened === null) return;
          this.documentSession.reset();
          this.fileTree.reset();
          this.root = opened.root;
          this.backgroundError = "";
          // 切库重置为单栏：旧库的文档、阅读栈与分栏布局都不跨库携带。
          for (const pane of this.paneList) pane.dispose();
          this.paneSeq = 1;
          this.paneList = [new ReaderPane(0, this.api, this.host, false)];
          this.activeId = 0;
          this.search.reset();

          this.search.input = "";
          this.candidateSelection = null;
          this.deadLink = null;
          this.clearViewModes();
          this.recent = [];
          this.notice = null;
          this.sessionNotice = null;
          this.listGeneration += 1;
          this.publishEntries(opened.entries);
          this.fileTree.restore(null, this.listed);
        } finally {
          opening.finish();
        }
      });
    } catch (error) {
      this.report(`打开库失败：${errorText(error)}`);
    }
  };

  /** 关闭指定分栏（仅分栏时）；未保存编辑先冲刷，失败不关。 */
  closePane = async (id: number): Promise<void> => {
    if (this.paneList.length < 2) return;
    const closing = this.paneById(id);
    if (closing === undefined) return;
    if (this.composing) {
      this.report("请先完成输入法组词，再关闭分栏。");
      return;
    }
    if (!(await closing.flushBeforeLeave())) {
      if (this.message === "") this.report("当前编辑尚未保存，请处理后再关闭分栏。");
      return;
    }
    closing.dispose();
    this.paneList = this.paneList.filter((pane) => pane.id !== id);
    if (this.activeId === id) this.activeId = this.paneList[0]!.id;
    this.persistDocumentsSafe();
  };

  /**
   * 在非活动栏打开文件并激活它；单栏只在文件加载成功后发布第二栏。
   *
   * 打开失败或门禁拒绝由该栏自己报告，当前栏的文档保持不动。
   */
  openInOtherPane = async (path: string): Promise<boolean> => {
    if (this.openingOther || this.composing || this.switching) return false;
    this.openingOther = true;
    const root = this.root;
    const existing = this.paneList.find((pane) => pane.id !== this.activeId);
    const other = existing ?? new ReaderPane(this.paneSeq++, this.api, this.host, false);
    try {
      await other.openFile(path);
      if (
        other.document.path !== path ||
        root !== this.root ||
        (existing && !this.paneList.includes(other))
      ) {
        if (!existing) other.dispose();
        return false;
      }
      if (!existing) this.paneList = [...this.paneList, other];
      this.activatePane(other.id);
      await this.persistDocumentsSafe();
      return true;
    } finally {
      this.openingOther = false;
    }
  };

  /** 激活分栏：命令、侧栏打开与工具栏状态都跟随活动栏。 */
  activatePane = (id: number): void => {
    if (this.paneById(id) !== undefined) this.activeId = id;
  };

  private paneById(id: number): ReaderPane | undefined {
    return this.paneList.find((pane) => pane.id === id);
  }

  /** 等待确认的死链创建；`null` 表示没有。 */
  get deadLinkOffer(): DeadLinkOffer | null {
    return this.deadLink?.offer ?? null;
  }

  /** 放弃从死链创建笔记。 */
  dismissDeadLink = (): void => {
    this.deadLink = null;
  };

  /**
   * 按死链原文创建笔记并在发起栏打开。
   *
   * `#标题` 锚点作为首个标题随创建事务一并写入，创建完成锚点即可解析；
   * 父目录不存在或名称冲突时保留当前文档，并给出创建失败原因。
   */
  confirmDeadLink = async (): Promise<void> => {
    const pending = this.deadLink;
    this.deadLink = null;
    if (pending === null) return;
    // 创建落在发起链接点击的那一栏；栏已关闭时回到活动栏。
    const pane = this.paneById(pending.paneId) ?? this.activePane;
    this.activatePane(pane.id);
    const seed = deadLinkSeed(pending.offer);
    const error = await this.createEntry(pending.offer.path, "file", seed ?? undefined);
    if (error !== null) {
      this.report(error);
      return;
    }
    // createEntry 已打开新文档，编辑器不一定完成挂载；
    // 走挂起定位，表面就绪后再跳，标题缺席时可见提示。
    await pane.openCreated(pending.offer);
  };

  /** 歧义链接的候选（升序）；`null` 表示没有等待中的选择。 */
  get linkCandidates(): { paths: string[]; anchor: string | null } | null {
    const selection = this.candidateSelection;
    return selection === null ? null : { paths: selection.paths, anchor: selection.anchor };
  }

  /** 关闭候选选择，不打开任何目标。 */
  dismissLinkCandidates = (): void => {
    this.candidateSelection = null;
  };

  /** 打开用户选中的候选；锚点在场时在发起栏继续定位标题。 */
  chooseLinkCandidate = async (chosen: string): Promise<void> => {
    const selection = this.candidateSelection;
    this.candidateSelection = null;
    if (selection === null) return;
    const pane = this.paneById(selection.paneId) ?? this.activePane;
    this.activatePane(pane.id);
    try {
      await pane.openResolved(chosen, selection.anchor);
    } catch (error) {
      this.report(`打开链接失败：${errorText(error)}`);
    }
  };

  /**
   * 快速切换器与别名补全的笔记身份；失败时返回原因文本。
   */
  listNoteKeys = async (): Promise<{ keys: NoteKeys[]; error: string | null }> => {
    try {
      const root = this.root;
      const request = ++this.keysRequest;
      const keys = await this.api.indexNoteKeys();
      if (request === this.keysRequest && root === this.root) this.keys = keys;
      return { keys, error: null };
    } catch (error) {
      return { keys: [], error: `标题与别名暂不可用：${errorText(error)}` };
    }
  };

  /**
   * 关闭请求等待全部分栏的空闲与保存门禁。
   * @returns 当前操作完成且最新编辑安全保存时为 true；失败保留窗口与编辑。
   */
  async flushBeforeClose(): Promise<boolean> {
    if (this.composing) {
      this.report("请先完成输入法组词，再关闭窗口。");
      return false;
    }
    while (this.paneList.some((pane) => !pane.idle))
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    try {
      const ready = await this.withAllPanesSaved(async () => {
        await this.persistDocuments();
        return true;
      });
      if (!ready && this.message === "") this.report("当前编辑尚未保存，请处理后再关闭。");
      return ready === true && (await this.fileTree.flush());
    } catch (error) {
      this.report(`阅读现场未能保存，请重试关闭：${errorText(error)}`);
      return false;
    }
  }

  /**
   * 切换工作空间前保存全部编辑与阅读位置；失败时保留可见文档供用户处理。
   * @returns 输入法组词、并发操作或保存冲突时返回 false；错误通过工作区显示。
   */
  async prepareSpaceChange(): Promise<boolean> {
    if (this.composing) {
      this.report("请先完成输入，再切换页面。");
      return false;
    }
    try {
      return (
        (await this.withAllPanesSaved(async () => {
          await this.persistDocuments();
          return true;
        })) === true
      );
    } catch (error) {
      this.report("阅读现场未能保存，请重试。", error);
      return false;
    }
  }

  /** 新建笔记后在活动栏打开，新建文件夹时保留当前文档；返回对话框错误或 null。 */
  createEntry(
    path: string,
    kind: VaultEntry["kind"],
    content?: Uint8Array,
  ): Promise<string | null> {
    return this.mutateEntries(
      "创建",
      () => this.api.entryCreate(path, kind, content),
      (pane, current) => (pane.id === this.activeId && kind === "file" ? path : current),
      false,
      null,
    );
  }

  /** 文件和文件夹统一移动；各栏文档跟随新路径，其他笔记的链接更新后重新加载。 */
  renameEntry(from: string, to: string): Promise<string | null> {
    if (from === to) return Promise.resolve(null);
    return this.mutateEntries(
      "重命名或移动",
      async () => this.syncArticleEntries(await this.api.entryRename(from, to), [{ from, to }]),
      (_pane, current) => {
        if (current === from) return to;
        return current?.startsWith(`${from}/`) ? `${to}${current.slice(from.length)}` : current;
      },
      true,
      (history) => {
        history.remapPath(from, to);
        this.remapViewModes(from, to);
        this.remapRecentFiles(from, to);
      },
    );
  }

  /** 移入系统废纸篓；关闭被删除目录中的文档，失败时保留编辑。 */
  trashEntry(path: string): Promise<string | null> {
    return this.mutateEntries(
      "移到废纸篓",
      async () =>
        this.syncArticleEntries(await this.api.entryTrash(path), [{ from: path, to: null }]),
      (_pane, current) => (current === path || current?.startsWith(`${path}/`) ? null : current),
      false,
      (history) => {
        history.remapPath(path, null);
        this.remapViewModes(path, null);
        this.remapRecentFiles(path, null);
      },
    );
  }

  /**
   * 全栏只保存一次后提交整批请求；只迁移已提交项，清单与文档最后统一刷新。
   * 预检/执行失败以可重试结果返回；提交后的界面错误放入 warning，不重做已提交文件。
   * @throws 桥接未返回有效结果时无法确认已提交范围，刷新目录后抛错，禁止盲目重试原批次。
   */
  async batchEntries(
    request: EntryBatchRequest,
    onProgress?: (progress: EntryBatchProgress) => void,
  ): Promise<EntryBatchResult> {
    let result: EntryBatchResult = {
      completed: [],
      remaining: [...request.paths],
      skipped: [],
      issues: [],
      warning: null,
    };
    const panes = [...this.paneList];
    const before = panes.map((pane) => pane.document.path);
    let awaitingReply = false;
    try {
      const allowed = await this.withAllPanesSaved(async () => {
        if (request.root !== this.root) throw new Error("笔记库已切换，请重新选择条目");
        await this.flushPendingDocuments();
        await this.fileTree.flush();
        this.listRequest += 1;
        awaitingReply = true;
        result = await (onProgress === undefined
          ? this.api.entryBatch(request)
          : this.api.entryBatch(request, onProgress));
        awaitingReply = false;
        result.warning = (
          await this.syncArticleEntries({ warning: result.warning }, result.completed)
        ).warning;
        if (result.completed.length === 0) {
          await this.refreshList();
          return true;
        }
        await this.applyCompletedEntries(request.action, result.completed, panes, before);
        if (!(await this.fileTree.flush()))
          result.warning = [result.warning, "目录状态未能保存，当前窗口内的选择仍保留。"]
            .filter(Boolean)
            .join("；");
        return true;
      });
      if (!allowed)
        result.issues.push({
          path: "",
          message: panes.some((pane) => pane.document.dirty)
            ? "当前编辑尚未保存，请先处理保存问题后重试。"
            : "正在处理其他操作，请稍后重试。",
        });
    } catch (error) {
      if (awaitingReply) {
        let detail = errorText(error);
        try {
          await this.refreshList();
        } catch (refreshError) {
          detail += `；目录刷新失败：${errorText(refreshError)}`;
        }
        throw new Error(`未能确认操作结果，请关闭后核对目录并重新选择条目。${detail}`);
      }
      if (result.completed.length === 0)
        result.issues.push({ path: "", message: errorText(error) });
      else {
        const warning = `文件操作已完成，但界面更新失败：${errorText(error)}`;
        result.warning = [result.warning, warning].filter(Boolean).join("；");
        for (const pane of panes) pane.clearDocument();
        try {
          await this.refreshList();
        } catch (refreshError) {
          result.warning += `；目录刷新失败：${errorText(refreshError)}`;
        }
      }
    }
    return result;
  }

  /** 请求当前批次在完整提交一项后停止；原批次仍负责返回结果与迁移会话。 */
  async stopBatchEntries(root: string): Promise<void> {
    await this.api.entryBatchStop(root);
  }

  /** 已提交范围统一迁移所有分栏与目录，再重载被链接改写影响的文档；失败由批量入口报告警告。 */
  private async applyCompletedEntries(
    action: EntryBatchRequest["action"],
    changes: EntryBatchResult["completed"],
    panes: readonly ReaderPane[],
    before: readonly (string | null)[],
  ): Promise<void> {
    const map = (path: string) => mapEntryPath(path, changes);
    for (const pane of panes) {
      for (const change of changes) pane.history.remapPath(change.from, change.to);
      if (pane.currentStep !== null) {
        const path = map(pane.currentStep.path);
        pane.currentStep = path === null ? null : { ...pane.currentStep, path };
      }
    }
    const views = mapViewModes(this.viewModes, map);
    if (views !== null) {
      this.clearViewModes();
      Object.assign(this.viewModes, views);
    }
    this.recent = mapPathList(this.recent, map) ?? this.recent;
    this.fileTree.remap(map);
    this.persistViewModes();
    this.persistRecentFiles();
    for (const [index, pane] of panes.entries()) {
      const oldPath = before[index] ?? null;
      const path = oldPath === null ? null : map(oldPath);
      if (path === null) pane.clearDocument();
      else if (path !== oldPath || action === "move") await pane.loadFile(path);
    }
    await this.refreshList();
    await this.persistDocumentsSafe();
  }

  /** 由主进程定位库内条目，错误通过工作区提示。 */
  revealEntry = async (path: string): Promise<void> => {
    try {
      await this.api.entryReveal(path);
    } catch (error) {
      this.report(`无法显示文件：${errorText(error)}`);
    }
  };

  /**
   * 条目变更的公共门禁与收尾：全栏保存后执行操作，各栏按映射重载，
   * 阅读栈、视图记忆与会话同口径迁移。
   */
  private async mutateEntries(
    label: string,
    operation: () => Promise<RenameOutcome>,
    nextPath: (pane: ReaderPane, current: string | null) => string | null,
    reload: boolean,
    remapHistory: ((history: ReaderHistory) => void) | null,
  ): Promise<string | null> {
    let committed = false;
    const panes = this.paneList;
    const before = panes.map((pane) => pane.document.path);
    let after: Array<string | null> = before;
    try {
      const completed = await this.withAllPanesSaved(async () => {
        await this.flushPendingDocuments();
        this.listRequest += 1;
        await this.fileTree.flush();
        after = panes.map((pane, index) => nextPath(pane, before[index] ?? null));
        const result = await operation();
        committed = true;
        // 阅读栈与视图记忆跟随改名/移动；删除的条目直接移除。
        if (remapHistory !== null) {
          this.fileTree.remap((path) => nextPath(this.activePane, path));
          for (const pane of panes) {
            remapHistory(pane.history);
            if (pane.currentStep !== null) {
              const mapped = nextPath(pane, pane.currentStep.path);
              pane.currentStep = mapped === null ? null : { ...pane.currentStep, path: mapped };
            }
          }
          this.persistViewModes();
          this.persistRecentFiles();
        }
        for (const [index, pane] of panes.entries()) {
          const target = after[index] ?? null;
          if (target !== (before[index] ?? null) || reload) {
            if (target === null) pane.clearDocument();
            else await pane.loadFile(target);
          }
        }
        await this.refreshList();
        await this.persistDocumentsSafe();
        this.report(result.warning === null ? "" : `操作已完成。${result.warning}`);
        return true;
      });
      // 门禁拒绝表示操作未执行，不能当作成功让对话框丢掉输入。
      if (!completed)
        return panes.some((pane) => pane.document.dirty)
          ? "当前编辑尚未保存，请先处理保存问题后重试。"
          : "正在处理其他操作，请稍后重试。";
      return null;
    } catch (error) {
      if (!committed) return `${label}失败：${errorText(error)}`;
      for (const [index, pane] of panes.entries()) {
        if (reload || pane.document.path !== (after[index] ?? null)) pane.clearDocument();
      }
      const pathAfter = after[this.paneList.findIndex((pane) => pane.id === this.activeId)] ?? null;
      this.report(
        `${label}已完成${pathAfter === null ? "" : `，当前路径 ${pathAfter}`}，但界面更新失败，请重新打开：${errorText(error)}`,
      );
      try {
        await this.refreshList();
      } catch (refreshError) {
        this.report(`${this.message}；文件列表刷新失败：${errorText(refreshError)}`);
      }
      return null;
    }
  }

  private async syncArticleEntries(
    result: RenameOutcome,
    changes: { from: string; to: string | null }[],
  ): Promise<RenameOutcome> {
    if (!this.root || changes.length === 0 || !this.onEntriesChanged) return result;
    try {
      await this.onEntriesChanged(this.root, changes);
      return result;
    } catch (error) {
      return {
        warning: [result.warning, `文章对话归属未能更新：${errorText(error)}`]
          .filter(Boolean)
          .join("；"),
      };
    }
  }

  /**
   * 全栏保存门禁：任何一栏拒绝（忙或有未保存编辑）则整体不执行。
   * @returns 门禁放行且操作完成时返回操作结果；被拒绝时 undefined。
   */
  private async withAllPanesSaved<T>(operation: () => Promise<T>): Promise<T | undefined> {
    return this.withAllPanesGated(async () => {
      for (const pane of this.paneList) if (!(await pane.settleForLeave())) return undefined;
      return operation();
    });
  }

  /** 工作区级串行门禁；保存和模式切换分别决定如何结算，不能互相穿插提交。 */
  private async withAllPanesGated<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.composing) return undefined;
    const gated: ReaderPane[] = [];
    try {
      for (const pane of this.paneList) {
        if (!pane.beginGate()) return undefined;
        gated.push(pane);
      }
      return await operation();
    } finally {
      for (const pane of gated) pane.finishTransition();
    }
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 文件操作或切库前排空已有阅读请求，避免路径迁移后重放旧现场；失败仍保留可见原因。 */
  private flushPendingDocuments(): Promise<void> {
    return this.persistSession(() => this.documentSession.flush(), READING_SESSION_ERROR);
  }

  /** 组合当前分栏状态并持久化；失败抛给调用方决定可见性。 */
  persistDocuments(): Promise<void> {
    this.documentSession.request();
    return this.documentSession.flush();
  }

  private async writeDocuments(isCurrent: () => boolean): Promise<void> {
    // 文档身份先于编辑器 DOM 更新；等换面完成后再捕获，不能把旧文档位置写给新路径。
    await tick();
    if (!isCurrent()) return;
    return this.api.sessionSetDocuments({
      panes: this.paneList.map((pane) => {
        const position =
          pane.document.path === null
            ? null
            : parseReadingBookmark(pane.navigation.capturePosition()?.reading);
        return {
          currentPath: pane.document.path,
          history: pane.history.snapshot(),
          outlineCollapsed: pane.outlineCollapsed,
          ...(position == null ? {} : { position }),
        };
      }),
      active: Math.max(
        0,
        this.paneList.findIndex((pane) => pane.id === this.activeId),
      ),
      split: this.paneList.length > 1,
    });
  }

  /** 已完成的导航或布局不因会话失败回滚；关窗门禁仍直接等待 persistDocuments。 */
  private persistDocumentsSafe(): Promise<void> {
    return this.persistSession(() => this.persistDocuments(), READING_SESSION_ERROR);
  }

  /**
   * 已完成操作的会话写入独立报告失败，保留内存状态；不会向调用方抛出写入异常。
   * 不同字段独立提交，后续正文或其他会话字段写入成功不能清除该错误。
   */
  private async persistSession(write: () => Promise<void>, message: string): Promise<void> {
    const generation = this.listGeneration;
    try {
      await write();
    } catch (error) {
      if (generation !== this.listGeneration) return;
      this.reportSessionFailure(message, error);
    }
  }

  private reportSessionFailure(message: string, error: unknown): void {
    this.sessionNotice = {
      kind: "attention",
      source: "operation",
      message,
      detail: errorText(error),
    };
  }

  /** 视图记忆独立写入；失败不打断切换，并说明跨重启恢复的影响。 */
  private persistViewModes(): void {
    void this.persistSession(
      () => this.api.sessionSetViewModes({ ...this.viewModes }),
      "视图记忆未能保存，下次打开可能恢复为原视图。请检查文件权限后重试。",
    );
  }

  /** 改名/删除后视图记忆跟随路径迁移；`to === null` 时移除。 */
  private remapViewModes(from: string, to: string | null): void {
    const mapped = mapViewModes(this.viewModes, (key) => {
      if (key === from) return to;
      if (key.startsWith(`${from}/`)) return to === null ? null : `${to}${key.slice(from.length)}`;
      return key;
    });
    if (mapped === null) return;
    this.clearViewModes();
    Object.assign(this.viewModes, mapped);
  }

  /** 最近打开列表独立写入；失败保留当前列表并报告，不能由文档会话代为补写。 */
  private persistRecentFiles(): void {
    // 响应式代理不能跨 contextBridge 结构化克隆，必须传普通数组。
    void this.persistSession(
      () => this.api.sessionSetRecentFiles([...this.recent]),
      "最近打开列表未能保存，下次打开可能缺少最近记录。请检查文件权限后重试。",
    );
  }

  /** 改名/删除后最近列表跟随路径迁移；`to === null` 时移除。 */
  private remapRecentFiles(from: string, to: string | null): void {
    const mapped = mapPathList(this.recent, (key) => {
      if (key === from) return to;
      if (key.startsWith(`${from}/`)) return to === null ? null : `${to}${key.slice(from.length)}`;
      return key;
    });
    if (mapped !== null) this.recent = mapped;
  }

  /** 清空视图记忆（切库）。 */
  private clearViewModes(): void {
    for (const key of Object.keys(this.viewModes)) delete this.viewModes[key];
  }

  private get refreshBlocked(): boolean {
    return (
      this.composing ||
      this.paneList.some((pane) => pane.switching || pane.copying || pane.document.saving)
    );
  }

  /** 附件导入、重试或关闭失败提示后，重新读取此前为保留插入上下文而推迟的磁盘版本。 */
  resumeExternalRefresh = (): void => {
    this.resumeVaultRefresh();
  };

  private resumeVaultRefresh(): void {
    if (!this.pendingRefresh || this.refreshBlocked) return;
    this.pendingRefresh = false;
    void this.onVaultChanged();
  }

  private async onVaultChanged(): Promise<void> {
    if (this.refreshBlocked) {
      this.pendingRefresh = true;
      return;
    }
    const request = ++this.refreshEpoch;
    try {
      await this.refreshList();
      for (const pane of [...this.paneList]) await this.refreshPaneFromDisk(pane, request);
    } catch (error) {
      this.report(`读取外部变更失败：${errorText(error)}`);
    }
  }

  /** 单栏的外部变更重读；归属按栏内 epoch 与全局请求序号双重校验。 */
  private async refreshPaneFromDisk(pane: ReaderPane, request: number): Promise<void> {
    const doc = pane.document;
    const { path, epoch, originalBytes } = doc;
    if (path === null || pane.switching) return;
    try {
      const snapshot = await this.api.fileSnapshot(path);
      const attachmentsReady = await pane.navigation.settleEditing("refresh");
      if (epoch !== doc.epoch || request !== this.refreshEpoch) return;
      if (!attachmentsReady) {
        this.pendingRefresh = true;
        return;
      }
      if (this.refreshBlocked || originalBytes !== doc.originalBytes) {
        this.pendingRefresh = true;
        this.resumeVaultRefresh();
        return;
      }
      doc.refresh(snapshot.disk, snapshot.diskError);
      if (doc.path === null) {
        pane.navigation.clear();
        pane.currentStep = null;
        await this.persistDocumentsSafe();
      } else if (doc.path === path) await pane.refreshReferences();
    } catch (error) {
      if (epoch === doc.epoch && !pane.switching)
        this.report(`读取外部变更失败：${errorText(error)}`);
    }
  }

  async refreshList(): Promise<void> {
    const root = this.root;
    const generation = this.listGeneration;
    const request = ++this.listRequest;
    const files = await this.api.vaultEntries();
    if (root !== this.root || generation !== this.listGeneration || request !== this.listRequest)
      return;
    this.publishEntries(files);
  }

  /** 完整目录在请求边界已校验；发布期间不执行会导致半切换的磁盘读取或会话写入。 */
  private publishEntries(files: VaultEntry[]): void {
    this.listed = files;
    this.fileTree.reconcile(files);
    this.revision += 1;
    this.refreshNoteKeys();
  }

  /**
   * 目录变化后重读笔记身份。别名补全是辅助能力：失败保留上次结果，不阻塞目录刷新。
   *
   * 用独立序号而不是目录世代判定过期：恢复流程在列目录之后才推进世代，
   * 借用世代会把启动时的第一份结果误当成过期丢弃。
   */
  private refreshNoteKeys(): void {
    const root = this.root;
    const request = ++this.keysRequest;
    void this.api.indexNoteKeys().then(
      (keys) => {
        if (request === this.keysRequest && root === this.root) this.keys = keys;
      },
      () => {},
    );
  }
}
