import { tick } from "svelte";
import type {
  HistoryAction,
  HistoryAvailability,
  LinkRecord,
  MentionRecord,
  Mentions,
  ReaderApi,
  SearchHit,
  SearchMatch,
} from "../../shared/api";
import type { CodeEditorApi, MarkdownEditorApi, TextEditorApi } from "../engine/editing/editor-api";
import { mentionOccurrenceIndex } from "../engine/navigation/backlinks";
import { normalizeHeadingText } from "../engine/navigation/heading-anchor";
import { buildOutlineTree, outlineEquals, type OutlineItem } from "../engine/navigation/outline";
import type { ReaderDocument } from "./document.svelte";
import type { EditorSnapshot } from "../engine/markdown/source-session";
import { verifySearchSnapshot } from "../engine/search/locate";
import type { EditorPosition } from "../engine/editing/editor-position";

/** 位置恢复只属于发起时的文档代次；挂载等待与布局等待共用同一个取消条件。 */
type PositionRestore = {
  epoch: number;
  revision: number;
  generation: number;
  position: EditorPosition;
  task: Promise<void> | null;
};

/** 等待编辑器挂载后兑现的定位；搜索范围必须属于当前内容版本。 */
type PendingJump =
  | { kind: "mention"; mention: MentionRecord; all: MentionRecord[] }
  | {
      kind: "search";
      hit: SearchHit;
      match: SearchMatch | undefined;
      onError: (message: string) => void;
    }
  | { kind: "heading"; path: string; anchor: string; onMissing: () => void };

/** 阅读上下文：目录折叠、引用查询及等待编辑器挂载后的定位，不参与文件写入。 */
export class ReaderNavigation {
  private headings = $state<OutlineItem[]>([]);
  private tree = $derived(buildOutlineTree(this.headings));
  private collapsed = $state<Record<string, string[]>>({});
  private references = $state<Mentions>({ linked: [], unlinked: [] });
  private outgoing = $state<LinkRecord[]>([]);
  private mentionGeneration = 0;
  private pending: { target: PendingJump; generation: number } | null = null;
  /** 同一目标的连续点击共用在途切换，不能因文档路径已更新而提前定位。 */
  private opening: { path: string; task: Promise<void> } | null = null;
  private jumpGeneration = 0;
  private markdown = $state.raw<MarkdownEditorApi | null>(null);
  private code = $state.raw<CodeEditorApi | null>(null);
  private markdownEpoch = -1;
  private codeEpoch = -1;
  private restoring: PositionRestore | null = null;

  /** @param document 用于判断查询、定位与编辑器所属文档的唯一状态。 */
  constructor(private readonly document: ReaderDocument) {}

  /** 当前编辑器接管历史动作；没有编辑器或焦点属于普通输入框时交还外壳。 */
  applyHistory(action: HistoryAction): boolean {
    return this.markdown?.history(action) ?? this.code?.history(action) ?? false;
  }

  /** 当前已挂载输入表面的历史投影；null 表示交由外壳查询原生控件。 */
  get historyAvailability(): HistoryAvailability | null {
    return this.markdown?.historyAvailability() ?? this.code?.historyAvailability() ?? null;
  }

  /** 打开活动 Markdown 文档的附件选择器；其他预览表面没有此动作。 */
  openAttachments(): void {
    this.markdown?.openAttachments();
  }

  /** 离开编辑器前等待附件引用进入文档，供保存门禁获取最终快照。 */
  settleAttachments(): Promise<boolean> {
    return this.markdown?.settleAttachments() ?? Promise.resolve(true);
  }

  /** 当前目录树，仅标题或层级变化时由编辑器更新。 */
  get outlineTree() {
    return this.tree;
  }
  /** 当前文档是否有目录。 */
  get hasOutline() {
    return this.document.content?.kind === "markdown" && this.headings.length > 0;
  }
  /** 每篇文件独立的目录折叠键。 */
  get collapsedKeys() {
    return this.document.path === null ? [] : (this.collapsed[this.document.path] ?? []);
  }
  /** 当前文档的已链接与未链接提及。 */
  get mentions() {
    return this.references;
  }
  /** 当前文档的索引出链，按文档顺序。 */
  get outlinks() {
    return this.outgoing;
  }

  /** 清除上一文档的引用并使其查询失效，等待中的跨文件定位仍保留。 */
  resetReferences(): void {
    this.mentionGeneration += 1;
    this.references = { linked: [], unlinked: [] };
    this.outgoing = [];
  }

  /** 清空工作区时同时丢弃目录与等待定位，不保留上一文档的界面状态。 */
  clear(): void {
    this.resetReferences();
    this.headings = [];
    this.pending = null;
    this.opening = null;
    this.restoring = null;
    this.jumpGeneration += 1;
  }

  /**
   * 查询当前文档的提及与出链；一次代次推进同时作废两类旧响应，
   * 切换文档或后续刷新开始后丢弃过期结果。
   *
   * 两类查询必须在同一入口推进代次：分开调用会引入「谁先执行」的
   * 隐式时序耦合，晚推进的一方会误作废另一方的在途响应。
   *
   * @param api 阅读器索引查询能力。
   * @returns 当前查询的错误文本或 null；旧查询的错误同样丢弃。
   */
  async refreshReferences(
    api: Pick<ReaderApi, "indexMentionsTo" | "indexLinksFrom">,
  ): Promise<string | null> {
    const { epoch, path } = this.document;
    const generation = ++this.mentionGeneration;
    if (path === null) return null;
    const isCurrent = () =>
      generation === this.mentionGeneration &&
      epoch === this.document.epoch &&
      path === this.document.path;
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    // allSettled：一类查询失败不能吞掉另一类的有效结果。
    const [mentions, outlinks] = await Promise.allSettled([
      api.indexMentionsTo(path),
      api.indexLinksFrom(path),
    ]);
    let error: string | null = null;
    if (mentions.status === "fulfilled") {
      if (isCurrent()) this.references = mentions.value;
    } else if (isCurrent()) {
      error = `引用暂不可用：${message(mentions.reason)}`;
    }
    if (outlinks.status === "fulfilled") {
      if (isCurrent()) this.outgoing = outlinks.value;
    } else if (isCurrent()) {
      error ??= `出链暂不可用：${message(outlinks.reason)}`;
    }
    return error;
  }

  /** @param items 编辑器解析出的标题；相同目录不触发重复更新。 */
  setOutline = (items: OutlineItem[]): void => {
    if (!outlineEquals(this.headings, items)) this.headings = items;
  };

  /** @param key 当前文件中需要切换展开状态的标题键。 */
  toggleOutline = (key: string): void => {
    const path = this.document.path;
    if (path === null) return;
    const keys = this.collapsed[path] ?? [];
    this.collapsed = {
      ...this.collapsed,
      [path]: keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
    };
  };

  /** @param pos 当前 Markdown 文档中的标题位置。 */
  jumpOutline(pos: number): void {
    this.jumpGeneration += 1;
    this.markdown?.jumpTo(pos);
  }

  /**
   * 在当前文档的活动大纲里按锚点定位标题。
   *
   * 大纲来自编辑器实时解析，未保存的新标题同样有效。
   * @param anchor 锚点原文。
   * @returns 是否找到并跳转。
   */
  jumpToHeadingText(anchor: string): boolean {
    if (this.document.content?.kind !== "markdown" || this.markdown === null) return false;
    if (anchor.startsWith("^")) {
      this.jumpGeneration += 1;
      return this.markdown.jumpToHeading(anchor);
    }
    const target = normalizeHeadingText(anchor);
    const item = this.headings.find((heading) => normalizeHeadingText(heading.text) === target);
    if (item === undefined) return false;
    this.jumpOutline(item.pos);
    return true;
  }

  /** 排版或阅读视图里选区所在章节的标题；源码视图与非 Markdown 文档没有章节概念，返回 `null`。 */
  currentHeading(): string | null {
    return this.markdown?.currentHeading() ?? null;
  }

  /**
   * 打开当前文档的查找入口；编辑器尚未挂载时不执行操作。
   *
   * 按已挂载表面分发：Markdown 的源码视图注册在代码通道上。
   */
  openSearch = (): void => {
    if (this.markdown !== null) this.markdown.openSearch();
    else this.code?.openSearch();
  };

  /** 文件操作完成后恢复写作焦点；只操作当前已挂载的编辑器，不改变选区或滚动位置。 */
  focusEditor = (): void => {
    if (this.markdown !== null) this.markdown.focus();
    else this.code?.focus();
  };

  /** 注册与注销时不清目录，目录清理由编辑器 onOutline 负责，避免挂载时状态竞争。 */
  registerMarkdown = (api: MarkdownEditorApi | null): void => {
    this.markdown = api;
    this.markdownEpoch = this.document.epoch;
    if (api !== null) {
      this.applyPendingJump();
      void this.applyPosition();
    }
  };

  /** @param api 当前文本编辑器；挂载完成后兑现等待定位，卸载时传 null。 */
  registerCode = (api: CodeEditorApi | null): void => {
    this.code = api;
    this.codeEpoch = this.document.epoch;
    if (api !== null) {
      this.applyPendingJump();
      void this.applyPosition();
    }
  };

  /** 读取当前表面的源码位置；挂载尚未完成时保留待恢复锚点，不用旧表面覆盖它。 */
  capturePosition(): EditorPosition | null {
    if (this.restoring !== null && this.positionIsCurrent(this.restoring))
      return this.restoring.position;
    return this.currentEditor()?.capturePosition() ?? null;
  }

  /**
   * 交接阅读锚点与可选选区；先等 Svelte 换面，再等编辑器布局，显式导航会取消旧恢复。
   * 编辑器尚未挂载时保留请求，由注册入口兑现；内容与正文历史均不改动。
   */
  async restorePosition(position: EditorPosition): Promise<void> {
    const restoring: PositionRestore = {
      epoch: this.document.epoch,
      revision: this.document.editRevision,
      generation: ++this.jumpGeneration,
      position,
      task: null,
    };
    this.restoring = restoring;
    await tick();
    await (restoring.task ?? this.applyPosition());
  }

  private positionIsCurrent(restoring: PositionRestore): boolean {
    return (
      this.restoring === restoring &&
      restoring.epoch === this.document.epoch &&
      restoring.revision === this.document.editRevision &&
      restoring.generation === this.jumpGeneration
    );
  }

  private applyPosition(): Promise<void> | null {
    const restoring = this.restoring;
    if (restoring === null || !this.positionIsCurrent(restoring)) return null;
    if (restoring.task !== null) return restoring.task;
    const editor = this.currentEditor();
    if (editor === null) return null;
    restoring.task = editor
      .restorePosition(
        restoring.position,
        () => this.positionIsCurrent(restoring) && editor === this.currentEditor(),
      )
      .finally(() => {
        if (this.restoring === restoring) this.restoring = null;
      });
    return restoring.task;
  }

  /**
   * @returns 当前已挂载表面的内容快照；Markdown 源码视图走代码通道。
   * @throws 编辑器未就绪或附件不支持编辑时抛出。
   */
  snapshot = (): EditorSnapshot => {
    if (this.markdown !== null) return this.markdown.snapshot();
    if (this.code !== null) return this.code.snapshot();
    throw new Error(
      this.document.content?.kind === "markdown" ? "文档编辑器尚未就绪" : "文本编辑器尚未就绪",
    );
  };

  /**
   * 打开引用来源并等待其编辑器挂载；切换被保存门禁阻止时取消定位。
   * @param mention 目标引用。
   * @param openFile 工作区提供的受保存门禁保护的文件切换。
   */
  async openMention(
    mention: MentionRecord,
    openFile: (path: string) => Promise<void>,
  ): Promise<void> {
    await this.openJump(
      mention.fromPath,
      { kind: "mention", mention, all: [...this.references.linked, ...this.references.unlinked] },
      openFile,
    );
  }

  /**
   * 打开指定的真实命中，挂载后核对内容版本；纯谓词命中只打开文件。
   * @param hit 命中文件及索引版本。
   * @param match 用户选择的具体命中；未提供时只打开文件。
   * @param openFile 工作区提供的受保存门禁保护的文件切换。
   * @param onError 过期或不可定位结果的可见反馈。
   */
  async openSearchMatch(
    hit: SearchHit,
    match: SearchMatch | undefined,
    openFile: (path: string) => Promise<void>,
    onError: (message: string) => void,
  ): Promise<void> {
    await this.openJump(hit.path, { kind: "search", hit, match, onError }, openFile);
  }

  /**
   * 打开锚点目标并等待其编辑器挂载后定位标题；门禁阻止时取消定位。
   * @param path 目标文件。
   * @param anchor 锚点原文。
   * @param openFile 工作区提供的受保存门禁保护的文件切换。
   * @param onMissing 目标文档里没有匹配标题时的可见反馈回调。
   */
  async openHeadingAnchor(
    path: string,
    anchor: string,
    openFile: (path: string) => Promise<void>,
    onMissing: () => void,
  ): Promise<void> {
    await this.openJump(path, { kind: "heading", path, anchor, onMissing }, openFile);
  }

  /** 挂载可以早于切换门禁释放；等文件切换与 DOM 解锁后，才允许定位交接焦点。 */
  private async openJump(
    path: string,
    pending: PendingJump,
    openFile: (path: string) => Promise<void>,
  ): Promise<void> {
    const generation = ++this.jumpGeneration;
    this.pending = null;
    if (this.opening?.path === path) await this.opening.task;
    else if (path !== this.document.path) {
      const opening = { path, task: openFile(path) };
      this.opening = opening;
      try {
        await opening.task;
      } finally {
        if (this.opening === opening) this.opening = null;
      }
    }
    await tick();
    if (generation !== this.jumpGeneration || path !== this.document.path) return;
    this.pending = { target: pending, generation };
    this.applyPendingJump();
  }

  private applyPendingJump(): void {
    const request = this.pending;
    if (request === null) return;
    if (request.generation !== this.jumpGeneration) {
      this.pending = null;
      return;
    }
    const pending = request.target;
    if (pending.kind === "search") {
      if (pending.hit.path !== this.document.path) return;
      const editor = this.currentEditor();
      if (editor === null) return;
      this.pending = null;
      void this.applySearchJump(pending, editor);
      return;
    }
    if (pending.kind === "heading") {
      if (pending.path !== this.document.path) return;
      // 锚点只对 Markdown 有意义；其余类型只打开文件，不提示。
      if (this.document.content?.kind === "markdown") {
        const editor = this.currentEditor();
        if (editor === null) return;
        if ("jumpToHeading" in editor && !editor.jumpToHeading(pending.anchor)) pending.onMissing();
      }
      this.pending = null;
      return;
    }
    if (pending.mention.fromPath !== this.document.path) return;
    const editor = this.currentEditor();
    if (editor === null) return;
    if ("jumpToMention" in editor) {
      editor.jumpToMention(pending.mention, mentionOccurrenceIndex(pending.all, pending.mention));
      // Markdown 源码视图注册在代码通道：字节区间对原始源文本同样有效。
    } else {
      editor.jumpToByte(pending.mention.startByte);
    }
    this.pending = null;
  }

  private async applySearchJump(
    pending: Extract<PendingJump, { kind: "search" }>,
    editor: TextEditorApi,
  ): Promise<void> {
    if (pending.match === undefined) return;
    const generation = this.jumpGeneration;
    const epoch = this.document.epoch;
    const current = () =>
      generation === this.jumpGeneration &&
      epoch === this.document.epoch &&
      pending.hit.path === this.document.path &&
      editor === this.currentEditor();
    try {
      const location = pending.match.location;
      if (location === null) throw new Error("此处暂无可靠的原文位置，可通过上下文查看命中内容。");
      const snapshot = editor.snapshot();
      await verifySearchSnapshot(snapshot, pending.hit.contentHash, location);
      if (current()) editor.jumpToSearch(location, snapshot);
    } catch (error) {
      if (current()) pending.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 文件状态先更新、组件后挂载；不能把旧表面当成新文件的编辑器。 */
  private currentEditor(): MarkdownEditorApi | CodeEditorApi | null {
    if (this.markdown !== null && this.markdownEpoch === this.document.epoch) return this.markdown;
    return this.codeEpoch === this.document.epoch ? this.code : null;
  }
}
