import type {
  ReaderApi,
  SearchHit,
  SearchQuery,
  SearchPage,
  SearchMatchesPage,
} from "../../shared/api";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { isEmptyQuery, parseSearchQuery } from "./query";

/** 文件续页只能追加同一次读取中尚未出现的路径，失败前不改变已发布内容。 */
function appendPage(previous: SearchPage, next: SearchPage): SearchPage {
  const paths = new SvelteSet(previous.hits.map((hit) => hit.path));
  if (next.hits.some((hit) => paths.has(hit.path)) || next.nextCursor === previous.nextCursor)
    throw new Error("搜索续页未前进，请重新搜索");
  return { hits: [...previous.hits, ...next.hits], nextCursor: next.nextCursor };
}

/** 单篇续页与精确总数共用校验，手动展开和后台补齐不能形成不同契约。 */
function appendMatches(hit: SearchHit, page: SearchMatchesPage): void {
  const loaded = hit.matches.length + page.matches.length;
  if (
    page.matches.length === 0 ||
    page.matches.length > 20 ||
    page.nextCursor === hit.matchesCursor ||
    (page.nextCursor === null ? loaded !== hit.matchCount : loaded >= hit.matchCount)
  )
    throw new Error("搜索命中续页与总数不一致，请重新搜索");
  hit.matches = [...hit.matches, ...page.matches];
  hit.matchesCursor = page.nextCursor;
}

/**
 * 全库搜索状态：请求 ID 负责内核取消，代次负责丢弃已经在传输途中的旧响应。
 * 首屏与续页分开表示，加载后续结果时保留已读内容、展开状态和键盘焦点。
 */
export class ReaderSearch {
  // 查询按提交整体替换，保留可跨进程序列化的原始值，不生成深层响应式代理。
  private submitted = $state.raw<SearchQuery | null>(null);
  private results = $state<SearchHit[]>([]);
  private failure = $state<string | null>(null);
  private running = $state(false);
  private paging = $state(false);
  private outdated = $state(false);
  private published = $state(0);
  private cursor = $state<string | null>(null);
  private matchRequests = $state<Record<string, { busy: boolean; error: string | null }>>({});
  private generation = 0;
  private requestId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private text = "";

  /** @param api 检索与取消命令；report 让退出搜索后发生的取消失败仍可见。 */
  constructor(
    private readonly api: Pick<ReaderApi, "searchQuery" | "searchCancel" | "searchMatches">,
    private readonly report: (message: string) => void,
  ) {}

  /** 解析失败也保留结果模式，避免错误被文件树遮蔽。 */
  get active(): boolean {
    return this.submitted !== null || this.failure !== null;
  }
  /** 已提交的有效检索条件；未提交或解析失败时为 null。 */
  get query(): SearchQuery | null {
    return this.submitted;
  }
  /** 当前查询已加载的文件，续页只追加同版本结果。 */
  get hits(): SearchHit[] {
    return this.results;
  }
  /** 完整结果替换的发布版本；分页追加不变，供界面迁移阅读位置和焦点身份。 */
  get revision(): number {
    return this.published;
  }
  /** 解析、首屏或续页失败原因；续页失败保留已有结果。 */
  get error(): string | null {
    return this.failure;
  }
  /** 已知库有变化；保留上次结果供阅读，但不能继续消费旧游标。 */
  get stale(): boolean {
    return this.outdated;
  }
  /** 首屏在途；此时不展示旧查询的命中。 */
  get busy(): boolean {
    return this.running;
  }
  /** 续页在途；重复加载请求合并，不重复消费同一游标。 */
  get loadingMore(): boolean {
    return this.paging;
  }
  /** 已证明还有后续命中，不能从页长猜测。 */
  get hasMore(): boolean {
    return this.cursor !== null;
  }

  /** 各文件独立加载，展开一篇不能阻塞另一篇或文件续页。 */
  loadingMatches(path: string): boolean {
    return this.matchRequests[path]?.busy ?? false;
  }

  /** 加载失败保留旧命中，并在所属文件内提供重新搜索入口。 */
  matchError(path: string): string | null {
    return this.matchRequests[path]?.error ?? null;
  }

  /** 按游标追加单篇命中；合并重复点击，只有成功发布本代结果才返回 true。 */
  async loadMatches(path: string): Promise<boolean> {
    const hit = this.results.find((item) => item.path === path);
    if (
      this.outdated ||
      this.running ||
      this.submitted === null ||
      this.requestId === null ||
      hit === undefined ||
      hit.matchesCursor === null ||
      this.loadingMatches(path)
    )
      return false;
    const generation = this.generation;
    const cursor = hit.matchesCursor;
    this.matchRequests[path] = { busy: true, error: null };
    try {
      const page = await this.api.searchMatches(this.submitted, this.requestId, cursor);
      if (generation !== this.generation) return false;
      appendMatches(hit, page);
      return true;
    } catch (error) {
      if (generation === this.generation)
        this.matchRequests[path] = { busy: false, error: this.message(error) };
      return false;
    } finally {
      if (generation === this.generation) this.matchRequests[path]!.busy = false;
    }
  }

  /**
   * 提交查询原文；空白退出，解析与执行失败都留在结果区显示原因，不向调用方抛错。
   * 仅当本次首屏确实发布时返回 true，供调用方移动焦点。
   */
  async run(text: string): Promise<boolean> {
    // 新提交先结束旧代次；解析失败也必须使旧首屏、文件续页与命中续页失效。
    this.reset();
    return this.execute(text);
  }

  private async execute(text: string): Promise<boolean> {
    const generation = this.generation;
    const coverage = new SvelteMap(this.results.map((hit) => [hit.path, hit.matches.length]));
    this.text = text;
    this.failure = null;
    try {
      const query = parseSearchQuery(text);
      if (isEmptyQuery(query)) return false;
      const id = crypto.randomUUID();
      this.requestId = id;
      this.submitted = query;
      this.running = true;
      const page = await this.readSnapshot(query, id, generation, coverage);
      if (page === null || generation !== this.generation) return false;
      this.results = page.hits;
      this.cursor = page.nextCursor;
      this.outdated = false;
      this.published += 1;
      return true;
    } catch (error) {
      if (generation === this.generation) this.failure = this.message(error);
      return false;
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }

  /** 新版本按原已加载范围补齐后一次发布；任何页面失败或代次变化都保留旧快照。 */
  private async readSnapshot(
    query: SearchQuery,
    id: string,
    generation: number,
    coverage: ReadonlyMap<string, number>,
  ): Promise<SearchPage | null> {
    let page = await this.api.searchQuery(query, id, null);
    if (generation !== this.generation) return null;
    while (page.nextCursor !== null && page.hits.length < coverage.size) {
      const next = await this.api.searchQuery(query, id, page.nextCursor);
      if (generation !== this.generation) return null;
      page = appendPage(page, next);
    }
    for (const hit of page.hits) {
      const loaded = coverage.get(hit.path) ?? 0;
      while (hit.matchesCursor !== null && hit.matches.length < loaded) {
        const next = await this.api.searchMatches(query, id, hit.matchesCursor);
        if (generation !== this.generation) return null;
        appendMatches(hit, next);
      }
    }
    return page;
  }

  /** 加载下一页；无游标或已有请求时不执行。失败保留当前列表并提供重新搜索入口。 */
  async loadMore(): Promise<void> {
    if (
      this.outdated ||
      this.running ||
      this.paging ||
      this.cursor === null ||
      this.submitted === null ||
      this.requestId === null
    )
      return;
    const generation = this.generation;
    this.paging = true;
    this.failure = null;
    try {
      const page = await this.api.searchQuery(this.submitted, this.requestId, this.cursor);
      if (generation !== this.generation) return;
      const merged = appendPage({ hits: this.results, nextCursor: this.cursor }, page);
      this.results = merged.hits;
      this.cursor = merged.nextCursor;
    } catch (error) {
      if (generation === this.generation) this.failure = this.message(error);
    } finally {
      if (generation === this.generation) this.paging = false;
    }
  }

  /** 按已提交原文刷新已加载的文件和命中范围；全部就绪后替换，失败保留旧内容。 */
  async refresh(): Promise<void> {
    if (!this.active) return;
    this.outdated = this.submitted !== null;
    this.cancelReads();
    await this.execute(this.text);
  }

  /**
   * 收到库变化后立即取消旧版本读取，合并 250 毫秒内的通知后自动刷新。
   * 首屏、文件续页与命中续页共用代次，迟到响应不能重新发布为最新结果。
   * 没有有效查询时不进入结果模式；取消失败仍通过工作区消息报告。
   */
  markStale(): void {
    if (this.submitted === null || this.refreshTimer !== null) return;
    this.outdated = true;
    this.cancelReads();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 250);
  }

  /** 退出结果模式，立即请求内核取消并丢弃在途响应；取消失败由工作区报告。 */
  reset(): void {
    this.cancelReads();
    this.text = "";
    this.submitted = null;
    this.results = [];
    this.cursor = null;
    this.failure = null;
    this.outdated = false;
    this.published += 1;
  }

  private cancelReads(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.cancelCurrent();
    this.generation += 1;
    this.running = false;
    this.paging = false;
    this.matchRequests = {};
  }

  private cancelCurrent(): void {
    const id = this.requestId;
    this.requestId = null;
    if (id !== null)
      void this.api.searchCancel(id).catch((error: unknown) => {
        this.report(`停止搜索失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private message(error: unknown): string {
    return `搜索失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
