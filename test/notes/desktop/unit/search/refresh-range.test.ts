/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { ReaderSearch } from "@reader/renderer/search/state.svelte";
import type { ReaderApi, SearchHit, SearchMatch, SearchPage } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const hit = (index: number, contentHash = "a".repeat(64)): SearchHit => ({
  path: `${index}.md`,
  title: `${index}`,
  snippet: "",
  contentHash,
  matches: [],
  matchCount: 0,
  matchesCursor: null,
});
const matches = (start: number, count: number): SearchMatch[] =>
  Array.from({ length: count }, (_, i) => ({
    snippet: `命中${start + i}`,
    location: { startByte: (start + i) * 10, endByte: (start + i) * 10 + 6, line: start + i + 1 },
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("搜索刷新范围", () => {
  it("超过单次查询上限的范围仍按原页长读取，不提高 limit 绕过分页契约", async () => {
    const searchQuery = vi.fn<ReaderApi["searchQuery"]>(async (query, _id, cursor) => {
      const start = cursor === null ? 0 : Number(cursor);
      const end = Math.min(start + query.limit, 605);
      return {
        hits: Array.from({ length: end - start }, (_, i) => hit(start + i)),
        nextCursor: end < 605 ? String(end) : null,
      };
    });
    const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
    await search.run("needle");
    while (search.hasMore) await search.loadMore();
    await search.refresh();
    expect(search.hits).toHaveLength(605);
    expect(searchQuery).toHaveBeenCalledTimes(14);
    expect(searchQuery.mock.calls.every(([query]) => query.limit === 100)).toBe(true);
  });

  it.each([0, 1])("结果减少到 %s 篇时接受新版本末页，不沿用旧游标", async (remaining) => {
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit(0), hit(1)], nextCursor: null })
      .mockResolvedValueOnce({ hits: remaining ? [hit(1)] : [], nextCursor: null });
    const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
    await search.run("needle");
    await search.refresh();
    expect(search.hits).toHaveLength(remaining);
    expect(search.hasMore).toBe(false);
    expect(searchQuery).toHaveBeenCalledTimes(2);
  });

  it("文件页齐全但命中补页失败时仍保留整份旧快照", async () => {
    const old = { ...hit(0), matches: matches(0, 5), matchCount: 6, matchesCursor: "old" };
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [old], nextCursor: null })
      .mockResolvedValueOnce({
        hits: [
          {
            ...hit(0, "b".repeat(64)),
            matches: matches(0, 5),
            matchCount: 6,
            matchesCursor: "new",
          },
        ],
        nextCursor: null,
      });
    const searchMatches = vi
      .fn<ReaderApi["searchMatches"]>()
      .mockResolvedValueOnce({ matches: matches(5, 1), nextCursor: null })
      .mockRejectedValueOnce(new Error("命中版本过期"));
    const search = new ReaderSearch(createReaderApiMock({ searchQuery, searchMatches }), vi.fn());
    await search.run("needle");
    await search.loadMatches("0.md");
    const previous = search.hits;
    await search.refresh();
    expect(search.hits).toBe(previous);
    expect(search.hits[0]?.matches).toHaveLength(6);
    expect(search.hits[0]?.contentHash).toBe("a".repeat(64));
    expect(search.error).toContain("命中版本过期");
  });

  it("105 条已加载结果按新游标补齐后一次发布，期间保持旧快照", async () => {
    const old = Array.from({ length: 105 }, (_, i) => hit(i));
    const fresh = Array.from({ length: 105 }, (_, i) => hit(i, "b".repeat(64)));
    const last = deferred<SearchPage>();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: old.slice(0, 100), nextCursor: "old-next" })
      .mockResolvedValueOnce({ hits: old.slice(100), nextCursor: null })
      .mockResolvedValueOnce({ hits: fresh.slice(0, 100), nextCursor: "new-next" })
      .mockReturnValueOnce(last.promise);
    const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
    await search.run("needle");
    await search.loadMore();
    const previous = search.hits;
    const refreshing = search.refresh();
    await vi.waitFor(() => expect(searchQuery).toHaveBeenCalledTimes(4));
    expect(search.hits).toBe(previous);
    expect(search.stale).toBe(true);
    expect(searchQuery.mock.calls[3]).toEqual([
      searchQuery.mock.calls[2]![0],
      searchQuery.mock.calls[2]![1],
      "new-next",
    ]);
    expect(searchQuery.mock.calls[2]![1]).not.toBe(searchQuery.mock.calls[0]![1]);
    last.resolve({ hits: fresh.slice(100), nextCursor: null });
    await refreshing;
    expect(search.hits).toEqual(fresh);
    expect(search.stale).toBe(false);
    expect(search.hasMore).toBe(false);
  });

  it("补页失败不发布半份结果，重试仍保留原加载范围", async () => {
    const old = [hit(0), hit(1)];
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [old[0]!], nextCursor: "old-next" })
      .mockResolvedValueOnce({ hits: [old[1]!], nextCursor: null })
      .mockResolvedValueOnce({ hits: [hit(2)], nextCursor: "new-next" })
      .mockRejectedValueOnce(new Error("搜索版本过期"))
      .mockResolvedValueOnce({ hits: [hit(3)], nextCursor: "retry-next" })
      .mockResolvedValueOnce({ hits: [hit(4)], nextCursor: null });
    const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
    await search.run("needle");
    await search.loadMore();
    await search.refresh();
    expect(search.hits).toEqual(old);
    expect(search.error).toContain("搜索版本过期");
    expect(search.stale).toBe(true);
    await search.refresh();
    expect(search.hits.map((item) => item.path)).toEqual(["3.md", "4.md"]);
  });

  it("补页中切换查询，迟到的旧快照不能覆盖新查询", async () => {
    const pending = deferred<SearchPage>();
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit(0), hit(1)], nextCursor: null })
      .mockResolvedValueOnce({ hits: [hit(2)], nextCursor: "next" })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ hits: [hit(9)], nextCursor: null });
    const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
    await search.run("old");
    const refreshing = search.refresh();
    await vi.waitFor(() => expect(searchQuery).toHaveBeenCalledTimes(3));
    await search.run("new");
    pending.resolve({ hits: [hit(3)], nextCursor: null });
    await refreshing;
    expect(search.hits.map((item) => item.path)).toEqual(["9.md"]);
    expect(search.stale).toBe(false);
  });

  it.each([26, 10])("恢复单篇已加载命中，当前总数为 %s 时按新版本末页收敛", async (count) => {
    const old = { ...hit(0), matches: matches(0, 5), matchCount: 26, matchesCursor: "old-matches" };
    const fresh = {
      ...hit(0, "b".repeat(64)),
      matches: matches(0, 5),
      matchCount: count,
      matchesCursor: "new-matches",
    };
    const searchMatches = vi
      .fn<ReaderApi["searchMatches"]>()
      .mockResolvedValueOnce({ matches: matches(5, 20), nextCursor: "old-last" })
      .mockResolvedValueOnce({ matches: matches(25, 1), nextCursor: null })
      .mockResolvedValueOnce({
        matches: matches(5, Math.min(20, count - 5)),
        nextCursor: count > 25 ? "new-last" : null,
      })
      .mockResolvedValueOnce({ matches: matches(25, 1), nextCursor: null });
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [old], nextCursor: null })
      .mockResolvedValueOnce({ hits: [fresh], nextCursor: null });
    const search = new ReaderSearch(createReaderApiMock({ searchQuery, searchMatches }), vi.fn());
    await search.run("needle");
    await search.loadMatches("0.md");
    await search.loadMatches("0.md");
    await search.refresh();
    expect(search.hits[0]?.matches).toHaveLength(count);
    expect(search.hits[0]?.matchesCursor).toBeNull();
    expect(searchMatches.mock.calls[2]?.[2]).toBe("new-matches");
    expect(searchMatches.mock.calls[2]?.[1]).toBe(searchQuery.mock.calls[1]?.[1]);
  });
});
