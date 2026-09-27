/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { SearchHit, SearchMatch, SearchMatchesPage } from "@reader/shared/api";
import { ReaderSearch } from "@reader/renderer/state/search.svelte";
import { SEARCH_DEPTH_LIMIT } from "@reader/shared/reader-protocol";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const match = (index: number): SearchMatch => ({
  snippet: "needle",
  location: { startByte: index * 7, endByte: index * 7 + 6, line: index + 1 },
});
const hit = (path: string): SearchHit => ({
  path,
  title: path,
  contentHash: "a".repeat(64),
  snippet: "needle",
  matches: Array.from({ length: 5 }, (_, i) => match(i)),
  matchCount: 26,
  matchesCursor: `more-${path}`,
});
function deferred() {
  let resolve!: (page: SearchMatchesPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SearchMatchesPage>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("单篇搜索命中续页", () => {
  it("按需请求、合并重复点击，追加时保持总数和查询可序列化", async () => {
    const pending = deferred();
    const api = createReaderApiMock({
      searchQuery: vi.fn(async () => ({ hits: [hit("a.md")], nextCursor: null })),
      searchMatches: vi.fn(async (query) => {
        structuredClone(query);
        return pending.promise;
      }),
    });
    const search = new ReaderSearch(api, vi.fn());
    await search.run("needle");
    expect(api.searchMatches).not.toHaveBeenCalled();
    const loading = search.loadMatches("a.md");
    await search.loadMatches("a.md");
    expect(api.searchMatches).toHaveBeenCalledTimes(1);
    expect(search.loadingMatches("a.md")).toBe(true);
    pending.resolve({
      matches: Array.from({ length: 20 }, (_, i) => match(i + 5)),
      nextCursor: "last",
    });
    expect(await loading).toBe(true);
    expect(search.hits[0]?.matches).toHaveLength(25);
    expect(search.hits[0]?.matchCount).toBe(26);
    expect(search.hits[0]?.matchesCursor).toBe("last");
    expect(search.loadingMatches("a.md")).toBe(false);
  });

  it("不同文件可并发，单个失败只保留该文件错误和旧命中", async () => {
    const first = deferred();
    const second = deferred();
    const api = createReaderApiMock({
      searchQuery: async () => ({ hits: [hit("a.md"), hit("b.md")], nextCursor: null }),
      searchMatches: vi.fn((_query, _id, cursor) =>
        cursor === "more-a.md" ? first.promise : second.promise,
      ),
    });
    const search = new ReaderSearch(api, vi.fn());
    await search.run("needle");
    const one = search.loadMatches("a.md");
    const two = search.loadMatches("b.md");
    first.reject(new Error("笔记库已更新"));
    second.resolve({
      matches: Array.from({ length: 20 }, (_, i) => match(i + 5)),
      nextCursor: "last",
    });
    await Promise.all([one, two]);
    expect(search.matchError("a.md")).toContain("笔记库已更新");
    expect(search.hits[0]?.matches).toHaveLength(5);
    expect(search.hits[1]?.matches).toHaveLength(25);
    expect(search.error).toBeNull();
  });

  it.each(["退出", "解析失败"])("%s会取消整个会话，迟到命中不能回填", async (action) => {
    const pending = deferred();
    const api = createReaderApiMock({
      searchQuery: vi.fn(async () => ({ hits: [hit("a.md")], nextCursor: null })),
      searchMatches: vi.fn(() => pending.promise),
    });
    const search = new ReaderSearch(api, vi.fn());
    await search.run("needle");
    const loading = search.loadMatches("a.md");
    if (action === "退出") search.reset();
    else await search.run(`${"-".repeat(SEARCH_DEPTH_LIMIT + 1)}needle`);
    pending.resolve({ matches: [match(5)], nextCursor: null });
    expect(await loading).toBe(false);
    expect(api.searchCancel).toHaveBeenCalled();
    expect(search.hits).toEqual([]);
    expect(search.matchError("a.md")).toBeNull();
  });

  it("不能接受虚假的末页、超出总数或不前进的游标", async () => {
    for (const page of [
      { matches: [match(5)], nextCursor: null },
      { matches: Array.from({ length: 22 }, (_, i) => match(i + 5)), nextCursor: null },
      { matches: Array.from({ length: 20 }, (_, i) => match(i + 5)), nextCursor: "more-a.md" },
    ]) {
      const api = createReaderApiMock({
        searchQuery: async () => ({ hits: [hit("a.md")], nextCursor: null }),
        searchMatches: async () => page,
      });
      const search = new ReaderSearch(api, vi.fn());
      await search.run("needle");
      await search.loadMatches("a.md");
      expect(search.hits[0]?.matches).toHaveLength(5);
      expect(search.matchError("a.md")).toContain("重新搜索");
    }
  });
});
