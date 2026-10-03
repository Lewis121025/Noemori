/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { ReaderSearch } from "@reader/renderer/search/state.svelte";
import type { ReaderApi, SearchHit, SearchPage, SearchMatchesPage } from "@reader/shared/api";
import { parseSearchRequest } from "@reader/renderer/search/query";
import { SEARCH_DEPTH_LIMIT } from "@reader/shared/reader-protocol";

const hit = (path: string): SearchHit => ({
  path,
  title: path,
  contentHash: "a".repeat(64),
  matches: [],
  snippet: "",
  matchCount: 0,
  matchesCursor: null,
});

const page = (...paths: string[]): SearchPage => ({ hits: paths.map(hit), nextCursor: null });
const searchCancel = vi.fn(async () => {});
const searchMatches = vi.fn<ReaderApi["searchMatches"]>();
const create = (searchQuery: ReaderApi["searchQuery"]) =>
  new ReaderSearch({ searchQuery, searchCancel, searchMatches }, vi.fn());

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReaderSearch", () => {
  it("命中续页跨越库变化时丢弃响应，退出搜索取消尚未触发的自动刷新", async () => {
    vi.useFakeTimers();
    const pending = deferred<SearchMatchesPage>();
    const first = { ...hit("a.md"), matchCount: 1, matchesCursor: "matches" };
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValue({ hits: [first], nextCursor: null });
    searchMatches.mockReturnValueOnce(pending.promise);
    const search = create(searchQuery);
    try {
      await search.run("alpha");
      const reading = search.loadMatches("a.md");
      search.markStale();
      pending.resolve({ matches: [{ snippet: "late", location: null }], nextCursor: null });
      expect(await reading).toBe(false);
      expect(search.hits[0]?.matches).toEqual([]);
      expect(search.loadingMatches("a.md")).toBe(false);
      search.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(searchQuery).toHaveBeenCalledOnce();
    } finally {
      search.reset();
      vi.useRealTimers();
    }
  });

  it("短时间内多次库变化只自动刷新一次，失败保留旧结果并允许重试", async () => {
    vi.useFakeTimers();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce(page("a.md"))
      .mockRejectedValueOnce(new Error("索引暂不可用"))
      .mockResolvedValueOnce(page("b.md"));
    const search = create(searchQuery);
    try {
      await search.run("alpha");
      search.markStale();
      await vi.advanceTimersByTimeAsync(100);
      search.markStale();
      await vi.advanceTimersByTimeAsync(150);
      expect(searchQuery).toHaveBeenCalledTimes(2);
      expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);
      expect(search.stale).toBe(true);
      expect(search.error).toContain("索引暂不可用");
      await vi.advanceTimersByTimeAsync(1000);
      expect(searchQuery).toHaveBeenCalledTimes(2);
      await search.refresh();
      expect(search.stale).toBe(false);
      expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    } finally {
      search.reset();
      vi.useRealTimers();
    }
  });

  it("库变化保留旧结果和查询，但取消续页；刷新后使用新任务和新结果", async () => {
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "next" })
      .mockResolvedValueOnce(page("b.md"));
    const search = create(searchQuery);
    await search.run("alpha");
    const previous = search.hits[0];
    search.markStale();
    expect(search.stale).toBe(true);
    expect(search.hits[0]).toBe(previous);
    expect(search.query).toEqual(parseSearchRequest("alpha"));
    expect(searchCancel).toHaveBeenCalledWith(searchQuery.mock.calls[0]?.[1]);
    await search.loadMore();
    expect(searchQuery).toHaveBeenCalledOnce();
    await search.refresh();
    expect(search.stale).toBe(false);
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    expect(searchQuery.mock.calls[1]?.[1]).not.toBe(searchQuery.mock.calls[0]?.[1]);
  });

  it.each(["首屏", "续页"])("库变化时取消在途%s，迟到响应不能清除过期标记", async (phase) => {
    const pending = deferred<SearchPage>();
    const searchQuery = vi.fn<ReaderApi["searchQuery"]>();
    if (phase === "续页")
      searchQuery.mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "next" });
    searchQuery.mockReturnValueOnce(pending.promise);
    const search = create(searchQuery);
    let loading: Promise<unknown>;
    if (phase === "续页") {
      await search.run("alpha");
      loading = search.loadMore();
    } else loading = search.run("alpha");
    search.markStale();
    pending.resolve(page("late.md"));
    await loading;
    expect(search.stale).toBe(true);
    expect(search.busy).toBe(false);
    expect(search.loadingMore).toBe(false);
    expect(search.hits.map((item) => item.path)).toEqual(phase === "续页" ? ["a.md"] : []);
    search.reset();
    expect(search.stale).toBe(false);
    expect(search.active).toBe(false);
    search.markStale();
    expect(search.active).toBe(false);
  });

  it("首屏和续页参数均能结构化克隆，响应式状态不能直接跨进程", async () => {
    const searchQuery = vi.fn<ReaderApi["searchQuery"]>(async (query, _id, cursor) => {
      structuredClone(query);
      return {
        hits: [hit(cursor === null ? "a.md" : "b.md")],
        nextCursor: cursor === null ? "next" : null,
      };
    });
    const search = create(searchQuery);
    await search.run("alpha tag:keep");
    await search.loadMore();
    expect(search.error).toBeNull();
    expect(search.hits.map((item) => item.path)).toEqual(["a.md", "b.md"]);
  });
  it("续页保留已有命中，重复点击只发一次请求；完成后才报告总数已确定", async () => {
    const next = deferred<SearchPage>();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "cursor-1" })
      .mockReturnValueOnce(next.promise);
    const search = create(searchQuery);
    await search.run("alpha");
    expect(search.hasMore).toBe(true);
    const loading = search.loadMore();
    await search.loadMore();
    expect(searchQuery).toHaveBeenCalledTimes(2);
    expect(searchQuery.mock.calls[1]).toEqual([
      parseSearchRequest("alpha"),
      searchQuery.mock.calls[0]?.[1],
      "cursor-1",
    ]);
    expect(search.busy).toBe(false);
    expect(search.loadingMore).toBe(true);
    expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);
    next.resolve(page("b.md"));
    await loading;
    expect(search.hits.map((item) => item.path)).toEqual(["a.md", "b.md"]);
    expect(search.hasMore).toBe(false);
    expect(search.loadingMore).toBe(false);
  });

  it("续页失败保留列表，重新搜索使用新任务 ID 和空游标", async () => {
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "cursor-1" })
      .mockRejectedValueOnce(new Error("笔记库已更新，请重新搜索"))
      .mockResolvedValueOnce(page("b.md"));
    const search = create(searchQuery);
    await search.run("alpha");
    await search.loadMore();
    expect(search.error).toContain("笔记库已更新");
    expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);
    await search.refresh();
    expect(searchQuery.mock.calls[2]?.[1]).not.toBe(searchQuery.mock.calls[0]?.[1]);
    expect(searchQuery.mock.calls[2]?.[2]).toBeNull();
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    expect(search.error).toBeNull();
  });

  it("切换查询会取消续页，其迟到结果不能追加到新查询", async () => {
    const next = deferred<SearchPage>();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "cursor-1" })
      .mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(page("c.md"));
    const search = create(searchQuery);
    await search.run("alpha");
    const loading = search.loadMore();
    await search.run("beta");
    expect(searchCancel).toHaveBeenCalledWith(searchQuery.mock.calls[0]?.[1]);
    next.resolve(page("b.md"));
    await loading;
    expect(search.hits.map((item) => item.path)).toEqual(["c.md"]);
    expect(search.loadingMore).toBe(false);
  });

  it("退出后的取消失败仍交给工作区报告", async () => {
    const report = vi.fn();
    const cancel = vi.fn(async () => {
      throw new Error("通道断开");
    });
    const search = new ReaderSearch(
      { searchQuery: async () => page("a.md"), searchCancel: cancel, searchMatches },
      report,
    );
    await search.run("alpha");
    search.reset();
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith("停止搜索失败：通道断开"));
  });

  it("提交查询进入结果模式，条件按查询文本解析", async () => {
    const searchQuery = vi.fn(async () => page("a.md"));
    const search = create(searchQuery);
    expect(search.active).toBe(false);
    await search.run("alpha tag:keep");
    expect(search.active).toBe(true);
    expect(searchQuery).toHaveBeenCalledWith(
      parseSearchRequest("alpha tag:keep"),
      expect.any(String),
      null,
    );
    expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);
    expect(search.error).toBeNull();
    expect(search.busy).toBe(false);
  });

  it("过期响应被丢弃：先发的查询后完成不覆盖后发结果", async () => {
    const first = deferred<SearchPage>();
    const second = deferred<SearchPage>();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const search = create(searchQuery);
    const runA = search.run("alpha");
    const firstId = searchQuery.mock.calls[0]?.[1];
    const runB = search.run("beta");
    expect(searchCancel).toHaveBeenCalledWith(firstId);
    second.resolve(page("b.md"));
    await runB;
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    first.resolve(page("a.md"));
    expect(await runA).toBe(false);
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    expect(search.busy).toBe(false);
  });

  it("reset 退出结果模式并丢弃在途响应", async () => {
    const pending = deferred<SearchPage>();
    const searchQuery = vi.fn<ReaderApi["searchQuery"]>().mockReturnValueOnce(pending.promise);
    const search = create(searchQuery);
    const running = search.run("alpha");
    search.reset();
    expect(searchCancel).toHaveBeenCalledWith(searchQuery.mock.calls[0]?.[1]);
    expect(search.active).toBe(false);
    pending.resolve(page("a.md"));
    await running;
    expect(search.hits).toEqual([]);
    expect(search.busy).toBe(false);
  });

  it("空文本不发起请求并退出结果模式", async () => {
    const searchQuery = vi.fn(async () => page());
    const search = create(searchQuery);
    await search.run("alpha");
    await search.run("   ");
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(search.active).toBe(false);
  });

  it("检索失败展示原因并清空结果，下一次成功自动清除错误", async () => {
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockRejectedValueOnce(new Error("索引损坏"))
      .mockResolvedValueOnce(page("a.md"));
    const search = create(searchQuery);
    await search.run("alpha");
    expect(search.error).toContain("搜索失败");
    expect(search.error).toContain("索引损坏");
    expect(search.hits).toEqual([]);
    expect(search.busy).toBe(false);
    await search.run("alpha");
    expect(search.error).toBeNull();
    expect(search.hits).toHaveLength(1);
  });

  it("解析失败留在可见的结果模式，不调用内核；修正查询后正常恢复", async () => {
    const searchQuery = vi.fn(async () => page("a.md"));
    const search = create(searchQuery);
    const invalid = `${"-".repeat(SEARCH_DEPTH_LIMIT + 1)}alpha`;
    await expect(search.run(invalid)).resolves.toBe(false);
    expect(search.active).toBe(true);
    expect(search.query).toBeNull();
    expect(search.error).toContain("检索条件嵌套过深");
    expect(search.busy).toBe(false);
    expect(search.hits).toEqual([]);
    expect(searchQuery).not.toHaveBeenCalled();

    await search.refresh();
    expect(search.error).toContain("检索条件嵌套过深");
    expect(searchQuery).not.toHaveBeenCalled();
    await expect(search.run("alpha")).resolves.toBe(true);
    expect(search.error).toBeNull();
    expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);

    await search.run(invalid);
    await search.run("   ");
    expect(search.active).toBe(false);
    expect(search.error).toBeNull();
  });

  it.each(["首屏", "续页"])("解析失败会取消旧%s，迟到结果不能覆盖错误", async (phase) => {
    const pending = deferred<SearchPage>();
    const searchQuery = vi.fn<ReaderApi["searchQuery"]>();
    if (phase === "续页")
      searchQuery.mockResolvedValueOnce({ hits: [hit("a.md")], nextCursor: "next" });
    searchQuery.mockReturnValueOnce(pending.promise);
    const search = create(searchQuery);
    let loading: Promise<unknown>;
    if (phase === "续页") {
      await search.run("alpha");
      loading = search.loadMore();
    } else loading = search.run("alpha");

    await expect(search.run(`${"-".repeat(SEARCH_DEPTH_LIMIT + 1)}beta`)).resolves.toBe(false);
    expect(searchCancel).toHaveBeenCalledWith(searchQuery.mock.calls[0]?.[1]);
    expect(search.active).toBe(true);
    expect(search.query).toBeNull();
    expect(search.hits).toEqual([]);
    expect(search.hasMore).toBe(false);
    expect(search.loadingMore).toBe(false);
    pending.resolve(page("late.md"));
    await loading;
    expect(search.hits).toEqual([]);
    expect(search.busy).toBe(false);
    expect(search.error).toContain("检索条件嵌套过深");
  });
});
