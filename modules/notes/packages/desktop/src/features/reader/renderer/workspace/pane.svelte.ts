import { tick } from "svelte";
import type { LinkKind, MentionRecord, ReaderApi } from "../../shared/api";
import type { ReadingBookmark } from "../../shared/reading-position";
import type { RememberedView } from "../../shared/session";
import { deadLinkCreatePath, type DeadLinkOffer } from "../links/dead-link";
import { externalUrl, hasUrlScheme } from "../../shared/link-target";
import type { AttachmentImporter } from "../../shared/attachments";
import { createAutosave } from "../document/autosave";
import {
  listSourceBlocks,
  newBlockId,
  takenBlockIds,
  withBlockId,
  type BlockCandidate,
  type BlockTarget,
} from "../links/block-list";
import { ReaderDocument } from "../document/state.svelte";
import { ReaderHistory, type ReadingStep } from "../navigation/history.svelte";
import { ReaderNavigation } from "../navigation/state.svelte";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Markdown 表面：排版（可编辑）、源码或阅读（只读排版）。 */
export type ViewMode = "wysiwyg" | RememberedView;

/** 保留 BOM 解码：块 ID 写回时 BOM 是文件字节的一部分。 */
function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** 标题锚点与 `^` 块引用共用跳转失败文案。 */
export function missingAnchor(anchor: string | null, openedFile: boolean): string {
  const kind = anchor?.startsWith("^") ? "块" : "标题";
  const label = anchor ?? "";
  return openedFile
    ? `未找到${kind}「${label}」，已打开文件开头`
    : `未找到${kind}「${label}」，锚点可能已失效`;
}

/**
 * 分栏对宿主（工作区）的最小依赖面。
 *
 * 结构化接口而不是工作区类型，避免状态模块之间的循环导入；
 * 提示、组词与会话持久化属于工作区级协调，分栏不各自持有。
 */
export type PaneHost = {
  /** 当前库根；附件导入归属校验用。 */
  vaultRoot: string | null;
  /** 输入法组词是否进行中；组词期间暂停保存与切换。 */
  composing: boolean;
  /** 等待组词结束。 */
  waitComposition(): Promise<void>;
  /** 需要用户处理或知晓的消息。 */
  report(message: string, error?: unknown): void;
  /** 仅在没有更重要的消息时报告（引用刷新等次要错误）。 */
  reportIfQuiet(message: string): void;
  /** 只属于产生它的分栏与文档版本的成功反馈；空字符串清除。 */
  announce(pane: ReaderPane, message: string): void;
  /** 保存结果的警告/清理走宿主消息通道，来源栏与保存动作绑定。 */
  noticeSaveWarning(warning: string | null): void;
  /** 死链创建确认（工作区级对话框）；记住来源栏。 */
  offerDeadLink(pane: ReaderPane, offer: DeadLinkOffer): void;
  /** 歧义候选选择（工作区级对话框）；记住来源栏。 */
  offerCandidates(pane: ReaderPane, paths: string[], anchor: string | null): void;
  /** 文件成功载入本栏；工作区据此维护跨栏共享的最近打开列表。 */
  noteOpened(path: string): void;
  /** 冲刷打开着 `path` 的各栏；任一栏仍有未保存编辑时返回 false。 */
  settlePath(path: string): Promise<boolean>;
  /** 视图记忆（按库内路径，跨栏共享）；排版视图是默认值，记为 null。 */
  viewModeOf(path: string): RememberedView | null;
  setViewMode(path: string, mode: RememberedView | null): void;
  /** 分栏文档/阅读栈/布局的会话持久化；失败抛给调用方决定可见性。 */
  persistDocuments(): Promise<void>;
  /** 目录快照刷新。 */
  refreshList(): Promise<void>;
  /** 写盘或切换结束后重放被推迟的外部变更。 */
  resumeVaultRefresh(): void;
  /** 本栏进入空闲；宿主等全部分栏空闲后放行关闭。 */
  onPaneIdle(pane: ReaderPane): void;
};

/**
 * 一个可编辑分栏：唯一文档、其导航/阅读栈/视图模式与串行切换门禁。
 *
 * 从工作区拆出的动机是分栏——「唯一活动文档」不再成立，但每栏内部的
 * 契约不变：离开文档先冲刷保存、异步结果按 epoch 归属、编辑与保存基准
 * 只属于本栏文档。工作区负责库级协调（列表、消息、会话、对话框）。
 */
export class ReaderPane {
  /** 栏位标识；会话与焦点跟踪用它归属。 */
  readonly id: number;
  /** 本栏唯一活动文档。 */
  readonly document: ReaderDocument;
  /** 与本栏文档绑定的目录、引用与定位。 */
  readonly navigation: ReaderNavigation;
  /** 本栏阅读栈。 */
  readonly history: ReaderHistory;
  /** 本栏导航落点；进入阅读栈的下一个条目。 */
  currentStep: { path: string; anchor: string | null } | null = null;
  /** 本栏 Markdown 视图；默认排版。 */
  view = $state<ViewMode>("wysiwyg");
  private transitioning = $state(false);
  private duplicating = $state(false);
  private idleWaiters: Array<() => void> = [];
  private readonly autosave;

  /**
   * @param id 栏位标识。
   * @param api 阅读器能力。
   * @param host 工作区协调面。
   * @param gated 初始是否处于门禁（启动恢复期 true，运行中新增空栏 false）。
   */
  constructor(
    id: number,
    private readonly api: ReaderApi,
    private readonly host: PaneHost,
    gated: boolean,
  ) {
    this.id = id;
    this.transitioning = gated;
    this.document = new ReaderDocument(api);
    this.navigation = new ReaderNavigation(this.document);
    this.history = new ReaderHistory();
    this.autosave = createAutosave({
      isDirty: () => this.document.dirty && !this.host.composing,
      save: () => this.persist(),
    });
  }

  /** 切换期间本栏禁止编辑，避免异步加载覆盖输入。 */
  get switching(): boolean {
    return this.transitioning;
  }
  /** 副本写入期间仍允许编辑，但不能切换文件。 */
  get copying(): boolean {
    return this.duplicating;
  }
  /** 本栏是否空闲（无切换/副本写入）。 */
  get idle(): boolean {
    return !this.transitioning && !this.duplicating;
  }
  /** 当前 Markdown 文档的视图模式。 */
  get viewMode(): ViewMode {
    return this.view;
  }

  /** 释放本栏计时器；卸载或关栏时调用。 */
  dispose(): void {
    this.autosave.dispose();
  }

  /** 组词期间暂停停键计时；结束后由 resumeAutosave 重新计时。 */
  pauseAutosave(): void {
    this.autosave.dispose();
  }

  /** 组词结束后恢复本栏的停键保存。 */
  resumeAutosave(): void {
    if (this.document.dirty) this.autosave.touch();
  }

  /** @param path 待打开的库内路径；保存门禁拒绝时保持当前文档。 */
  openFile = async (path: string): Promise<void> => {
    if (path === this.document.path) return;
    try {
      await this.withSavedDocument(async () => {
        // 门禁已通过、加载成功才入栈：失败不留下幽灵历史。
        const previous = this.captureCurrentStep();
        await this.loadFile(path, true);
        if (previous !== null) this.history.pushStep(previous);
        this.currentStep = { path, anchor: null };
        await this.host.persistDocuments();
      });
    } catch (error) {
      this.host.report(`打开文件失败：${errorText(error)}`);
    }
  };

  /** 后退到上一个阅读位置；门禁拒绝或栈空时不动。 */
  navigateBack = async (): Promise<void> => {
    await this.navigateHistory("back");
  };

  /** 前进到下一个阅读位置；门禁拒绝或栈空时不动。 */
  navigateForward = async (): Promise<void> => {
    await this.navigateHistory("forward");
  };

  private async navigateHistory(direction: "back" | "forward"): Promise<void> {
    if (this.currentStep === null) return;
    const current = this.captureCurrentStep();
    const target = direction === "back" ? this.history.peekBack() : this.history.peekForward();
    if (target === null || current === null) return;
    try {
      await this.withSavedDocument(async () => {
        if (target.path !== this.document.path) await this.loadFile(target.path, true);
        if (direction === "back") this.history.commitBack(current);
        else this.history.commitForward(current);
        this.currentStep = { path: target.path, anchor: target.anchor };
        if (target.position !== undefined) {
          await this.navigation.restorePosition({ reading: target.position, selection: null });
        } else if (!(await this.history.applyScroll(target)) && target.anchor !== null) {
          // 后退恢复离开时的现场；重启后没有现场记录，才回退到原链接标题。
          await this.navigation.openHeadingAnchor(target.path, target.anchor, this.openFile, () =>
            this.host.report(missingAnchor(target.anchor, true)),
          );
        }
        void this.host.persistDocuments().catch(() => {});
      });
    } catch (error) {
      this.host.report(`${direction === "back" ? "后退" : "前进"}失败：${errorText(error)}`);
    }
  }

  /** 当前落点加滚动位置；没有打开文档时为 null。 */
  captureCurrentStep(): ReadingStep | null {
    if (this.currentStep === null) return null;
    const position = this.navigation.capturePosition()?.reading;
    return this.history.captureStep({
      ...this.currentStep,
      ...(position == null ? {} : { position }),
    });
  }

  /** @param kind 链接语法。@param raw 链接原文。@param from 预览来源；过期解析不切换文档。 */
  openLink = async (kind: LinkKind, raw: string, from?: string): Promise<void> => {
    if (
      this.document.path === null ||
      this.transitioning ||
      this.duplicating ||
      this.host.composing
    )
      return;
    const { path, epoch } = this.document;
    const origin = from ?? path;
    try {
      if (hasUrlScheme(raw)) {
        await this.api.openExternal(externalUrl(raw));
        return;
      }
      const target = await this.api.linksResolve(origin, raw, kind);
      if (epoch !== this.document.epoch || this.transitioning || this.duplicating) return;
      switch (target.status) {
        case "dead": {
          const offer = deadLinkCreatePath(origin, raw, kind);
          if (offer === null) {
            this.host.report("死链，无法跳转");
            return;
          }
          this.host.offerDeadLink(this, offer);
          return;
        }
        case "ambiguous":
          // 同名多候选不静默取一，交给用户选择；锚点在选择后继续生效。
          this.host.offerCandidates(this, target.candidates, target.anchor);
          return;
        case "resolved":
          await this.openResolved(target.path, target.anchor);
          return;
      }
    } catch (error) {
      if (epoch === this.document.epoch) this.host.report(`打开链接失败：${errorText(error)}`);
    }
  };

  /** 打开唯一解析目标；带锚点时定位标题，失效锚点可见提示而不是空吞。 */
  async openResolved(path: string, anchor: string | null): Promise<void> {
    if (anchor === null) {
      await this.openFile(path);
      return;
    }
    if (path === this.document.path) {
      const previous = this.captureCurrentStep();
      // 当前文档用活动大纲：未保存的新标题同样有效。
      if (!this.navigation.jumpToHeadingText(anchor)) {
        this.host.report(missingAnchor(anchor, false));
        return;
      }
      // 同文档锚点跳转也算阅读栈的一跳，后退可回到跳转前的位置。
      if (previous !== null) this.history.pushStep(previous);
      this.currentStep = { path, anchor };
      void this.host.persistDocuments().catch(() => {});
      return;
    }
    await this.navigation.openHeadingAnchor(path, anchor, this.openFile, () =>
      this.host.report(missingAnchor(anchor, true)),
    );
    // openFile 已入栈并记录落点；这里把锚点补进当前条目。
    if (this.document.path === path && this.currentStep?.path === path)
      this.currentStep = { path, anchor };
  }

  /**
   * 死链创建成功后的挂起定位：编辑器不一定完成挂载，
   * 表面就绪后再跳，标题缺席时可见提示。
   */
  async openCreated(offer: DeadLinkOffer): Promise<void> {
    if (offer.anchor === null) return;
    await this.navigation.openHeadingAnchor(offer.path, offer.anchor, this.openFile, () =>
      this.host.report(missingAnchor(offer.anchor, true)),
    );
  }

  /** 源码视图与排版/阅读视图之间切换（排版与阅读都回到排版）。 */
  toggleViewMode = (): Promise<void> =>
    this.switchView(this.view === "source" ? "wysiwyg" : "source");

  /** 阅读视图与排版视图之间切换；从源码视图进入阅读视图同样交接文本。 */
  toggleReadingMode = (): Promise<void> =>
    this.switchView(this.view === "reading" ? "wysiwyg" : "reading");

  /**
   * 切换 Markdown 视图并记住选择。
   *
   * 排版文档模型是 Markdown 的有损投影；源码视图直接编辑字节，
   * 「排版表达不了的语法保存时被重写」由源码模式从构造上消除。
   * 跨越源码边界时以当前活动表面的快照为交接文本：未保存编辑随文本带过去，
   * 保存基准与脏标记不变。存在无法保真保存的编辑（needsSourceRepair）
   * 时拒绝进出源码——恢复记录属于排版会话，不能静默丢弃。
   * 排版与阅读共用同一编辑器，只切换是否可编辑，不需要交接。
   */
  private async switchView(target: ViewMode): Promise<void> {
    const path = this.document.path;
    if (path === null || this.document.content?.kind !== "markdown" || target === this.view) return;
    if (this.transitioning || this.duplicating || this.host.composing) return;
    const crossesSource = target === "source" || this.view === "source";
    if (crossesSource && this.document.needsSourceRepair) {
      this.host.report("当前文档存在无法保真保存的编辑，请先处理保存问题再切换视图。");
      return;
    }
    if (!this.beginGate()) return;
    let released = false;
    try {
      if (crossesSource) {
        // 先冲刷挂起的保存；冲突失败时编辑随快照文本带到新表面。
        await this.autosave.flush();
        if (this.document.path !== path) return;
      }
      // 同一排版表面由浏览器保留原滚动锚点；只有换成源码时才需要跨模型交接。
      const position = crossesSource ? this.navigation.capturePosition() : null;
      if (crossesSource) {
        // ignoreBOM：BOM 是文件字节的一部分，切换视图必须原样带走。
        const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          this.navigation.snapshot().bytes,
        );
        this.document.replaceSourceText(text);
      }
      this.view = target;
      this.host.setViewMode(path, target === "wysiwyg" ? null : target);
      const epoch = this.document.epoch;
      const restoring = position === null ? null : this.navigation.restorePosition(position);
      await tick();
      // 新表面就绪即解除输入门禁；后续布局校正可被下一次切换或输入取消。
      this.finishTransition();
      released = true;
      await tick();
      if (this.document.epoch === epoch && this.view === target && !this.transitioning)
        this.navigation.focusEditor();
      await restoring;
    } catch (error) {
      this.host.report(`切换视图失败：${errorText(error)}`, error);
    } finally {
      if (!released) this.finishTransition();
    }
  }

  /** 滚动结束时写入本栏阅读现场；保存失败可见提示，关窗时仍会重新冲刷。 */
  rememberReadingPosition = (): void => {
    if (!this.idle || this.host.composing || !this.document.canEdit) return;
    void this.host.persistDocuments().catch((error: unknown) => {
      this.host.report(`阅读位置未能写入会话：${errorText(error)}`);
    });
  };

  /**
   * 补全弹层：解析链接目标并返回其标题文本。
   *
   * 目标死链、歧义或索引失败都退化为空候选——补全是尽力而为的辅助能力，
   * 不为它弹错误提示，也不打断写作。
   */
  suggestHeadings = async (target: string, kind: LinkKind): Promise<string[]> => {
    const from = this.document.path;
    if (from === null || target.trim() === "") return [];
    try {
      const resolved = await this.api.linksResolve(from, target, kind);
      if (resolved.status !== "resolved") return [];
      const headings = await this.api.indexHeadings(resolved.path);
      return headings.map((heading) => heading.text);
    } catch {
      return [];
    }
  };

  /**
   * 块补全的目标与块清单。
   *
   * 空目标或解析到本笔记时交给编辑器处理（包含未保存编辑）；其他笔记读磁盘源码。
   * 死链、歧义与读取失败退化为 null，补全不弹错误。
   */
  suggestBlocks = async (target: string, kind: LinkKind): Promise<BlockTarget | null> => {
    const from = this.document.path;
    if (from === null) return null;
    if (target.trim() === "") return { kind: "self" };
    try {
      const resolved = await this.api.linksResolve(from, target, kind);
      if (resolved.status !== "resolved") return null;
      if (resolved.path === from) return { kind: "self" };
      const source = decodeSource(await this.api.fileRead(resolved.path));
      return { kind: "file", path: resolved.path, blocks: listSourceBlocks(source) };
    } catch {
      return null;
    }
  };

  /**
   * 确保其他笔记里的块带有 ID，返回可写进链接的 ID。
   *
   * 先冲刷打开着目标的分栏，再以读取时的字节为基准写入；块文字已变化或写入
   * 冲突时报告原因并返回 null，调用方不插入链接。
   */
  ensureBlockId = async (path: string, block: BlockCandidate): Promise<string | null> => {
    if (block.id !== null) return block.id;
    try {
      if (!(await this.host.settlePath(path))) {
        this.host.report("目标笔记有未保存的编辑，请先处理后再引用其中的块。");
        return null;
      }
      const bytes = await this.api.fileRead(path);
      const source = decodeSource(bytes);
      const blocks = listSourceBlocks(source);
      const current = blocks[block.index];
      if (current === undefined || current.text !== block.text) {
        this.host.report("目标笔记已变化，请重新选择要引用的块。");
        return null;
      }
      if (current.id !== null) return current.id;
      const id = newBlockId(takenBlockIds(blocks));
      const next = new TextEncoder().encode(withBlockId(source, current, id));
      const result = await this.api.fileWrite(path, next, bytes);
      if (result.status === "conflict") {
        this.host.report("目标笔记刚被修改，块 ID 未写入，请重试。");
        return null;
      }
      if (result.warning !== null) this.host.report(`块 ID 已写入。${result.warning}`);
      return id;
    } catch (error) {
      this.host.report(`写入块 ID 失败：${errorText(error)}`, error);
      return null;
    }
  };

  /**
   * 把未链接提及就地转为指向 `target` 的链接：内核按字节区间改写来源
   * 文件，不打开它。区间过期时内核拒绝改写，错误原样可见。
   */
  linkifyMention = async (mention: MentionRecord, target: string): Promise<void> => {
    try {
      const result = await this.api.mentionsLinkify(
        mention.fromPath,
        mention.startByte,
        mention.endByte,
        mention.toRaw,
        target,
      );
      // 来源文件的出链与本笔记的入链都变了；先刷新再报告结果。
      await this.refreshReferences();
      if (result.warning !== null) this.host.report(`已转为链接。${result.warning}`);
      else this.host.announce(this, `已把「${mention.toRaw}」转为链接。`);
    } catch (error) {
      this.host.report(`转为链接失败：${errorText(error)}`, error);
    }
  };

  /** 编辑器变更后启动停键保存；附件不会产生写入。 */
  markDirty = (): void => {
    if (!this.document.canEdit) return;
    this.document.markDirty();
    if (!this.host.composing) this.autosave.touch();
  };

  /** 手动保存与快捷键复用同一串行调度。 */
  requestSave = (): void => {
    if (this.host.composing) return;
    void this.autosave.flush();
  };

  /** 捕获附件所属的库、路径和编辑会话；异步读取结束后不能借用新文档的身份。 */
  captureAttachmentImporter(): AttachmentImporter {
    const root = this.host.vaultRoot;
    const path = this.document.path;
    const epoch = this.document.epoch;
    return (name, bytes) => {
      if (
        root === null ||
        path === null ||
        epoch !== this.document.epoch ||
        root !== this.host.vaultRoot
      )
        return Promise.reject(new Error("文档已切换，请回到原笔记重新插入附件"));
      return this.api.attachmentImport(root, path, name, bytes);
    };
  }

  /** 另存副本保留原文件；写入期间输入由文档状态带入新路径。 */
  saveCopy = async (): Promise<void> => {
    const doc = this.document;
    if (
      doc.path === null ||
      this.transitioning ||
      this.duplicating ||
      this.host.composing ||
      doc.saving ||
      !doc.canEdit
    )
      return;
    this.duplicating = true;
    this.autosave.dispose();
    let savedPath: string | null = null;
    try {
      if (!(await this.navigation.settleEditing())) {
        this.host.report("附件尚未完成导入，请重试剩余附件，或关闭附件错误提示后再另存。");
        return;
      }
      const copy = await doc.copy(this.navigation.snapshot, () => this.host.waitComposition());
      savedPath = copy.path;
      if (copy.refreshError !== null) throw new Error(copy.refreshError);
      this.navigation.resetReferences();
      if (copy.warning !== null) this.host.report(`副本已创建为 ${copy.path}。${copy.warning}`);
      else
        this.host.announce(
          this,
          `副本已保存为 ${copy.path}。${doc.dirty ? "后续编辑尚未保存。" : "原文件已保留。"}`,
        );
      await this.host.persistDocuments();
      await this.host.refreshList();
      await this.refreshReferences();
    } catch (error) {
      if (savedPath === null) doc.recordSaveError(error);
      else
        this.host.report(
          `副本已保存为 ${savedPath}，但工作区状态未能更新。请从文件栏重新打开该副本；若问题持续，请查看详细原因。`,
          error,
        );
    } finally {
      this.duplicating = false;
      this.host.resumeVaultRefresh();
      if (doc.dirty) this.autosave.touch();
      this.notifyIdle();
    }
  };

  /**
   * 本栏保存门禁：串行化切换类操作，离开文档前冲刷保存。
   * @returns 门禁放行且操作完成时返回操作结果；被拒绝时 undefined。
   */
  async withSavedDocument<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.beginGate()) return undefined;
    try {
      if (!(await this.settleForLeave())) return undefined;
      return await operation();
    } finally {
      this.finishTransition();
    }
  }

  /** 附件结算 + 保存冲刷 + 脏检查；调用方须已持有门禁。 */
  async settleForLeave(): Promise<boolean> {
    if (!(await this.navigation.settleEditing())) {
      this.host.report("附件尚未完成导入，请重试剩余附件，或关闭附件错误提示后再离开。");
      return false;
    }
    await this.autosave.flush();
    return !this.document.dirty && !this.host.composing;
  }

  /** 进入门禁（工作区级操作用）；已在门禁或组词中返回 false。 */
  beginGate(): boolean {
    if (this.transitioning || this.duplicating || this.host.composing) return false;
    this.transitioning = true;
    return true;
  }

  finishTransition(): void {
    this.transitioning = false;
    this.host.resumeVaultRefresh();
    this.notifyIdle();
  }

  /** 等待本栏空闲。 */
  waitIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (!this.idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
    this.host.onPaneIdle(this);
  }

  clearDocument(): void {
    this.document.clear();
    this.navigation.clear();
    this.view = "wysiwyg";
    this.currentStep = null;
  }

  /**
   * 加载文档：按源码视图记忆恢复视图，写会话并刷新引用。
   * 调用方须已持有本栏门禁。
   * @param path 库内路径；读取或解析失败时保留原文档与滚动位置。
   * @param fromStart 新导航先归零，再由目标定位；改名和同文档重载不归零。
   * @param position 重启恢复的正文锚点；不用于普通文件打开或显式目标导航。
   */
  async loadFile(path: string, fromStart = false, position?: ReadingBookmark): Promise<void> {
    this.document.load(path, await this.api.fileSnapshot(path));
    if (fromStart) this.history.resetScroll();
    this.host.noteOpened(path);
    // 恢复记录属于排版会话；带恢复记录的文件不进源码视图，
    // 否则记住的源码视图会让未写入磁盘的编辑静默缺席。
    const remembered = this.host.viewModeOf(path);
    this.view =
      remembered === null || (remembered === "source" && this.document.needsSourceRepair)
        ? "wysiwyg"
        : remembered;
    this.navigation.resetReferences();
    if (position !== undefined && !this.document.needsSourceRepair)
      await this.navigation.restorePosition({ reading: position, selection: null });
    this.host.announce(this, this.document.dirty ? "已恢复上次未保存的编辑，请检查后保存。" : "");
    await this.host.persistDocuments();
    await this.refreshReferences();
  }

  async refreshReferences(): Promise<void> {
    const error = await this.navigation.refreshReferences(this.api);
    if (error !== null) this.host.reportIfQuiet(error);
  }

  /** 停键保存；结果与警告经宿主消息通道，保存基准属于本栏文档。 */
  async persist(): Promise<void> {
    if (this.duplicating || this.host.composing) return;
    try {
      const result = await this.document.save(this.navigation.snapshot);
      if (result?.status === "saved") {
        this.host.noticeSaveWarning(result.warning);
        await this.refreshReferences();
      }
    } finally {
      this.host.resumeVaultRefresh();
    }
  }

  /** 关栏/关窗前的冲刷：等待空闲并保存未落盘编辑。 */
  async flushBeforeLeave(): Promise<boolean> {
    await this.waitIdle();
    const ready = await this.withSavedDocument(async () => true);
    return ready === true;
  }
}
