import { describe, expect, it } from "vitest";
import {
  parseSearchCursor,
  parseSearchId,
  parseSearchPage,
  parseSearchQueryArgument,
  parseSearchMatchesPage,
  parseSearchMatchesCursor,
} from "@reader/shared/reader-protocol";

const hit = {
  path: "note.md",
  title: "Note",
  snippet: "",
  contentHash: "a".repeat(64),
  matches: [],
  matchCount: 0,
  matchesCursor: null,
};

describe("搜索分页边界", () => {
  it("命中总数和续页必须一致，拒绝无限响应和虚假结束", () => {
    const match = { snippet: "needle", location: { startByte: 0, endByte: 6, line: 1 } };
    for (const invalid of [
      { ...hit, matchCount: 1 },
      { ...hit, matchCount: -1 },
      { ...hit, matchCount: 6, matches: Array(6).fill(match), matchesCursor: null },
      { ...hit, matchCount: 8, matches: Array(5).fill(match), matchesCursor: null },
      { ...hit, matchCount: 5, matches: Array(5).fill(match), matchesCursor: "more" },
    ])
      expect(() => parseSearchPage({ hits: [invalid], nextCursor: null })).toThrow();
    expect(parseSearchMatchesPage({ matches: [match], nextCursor: null })).toEqual({
      matches: [match],
      nextCursor: null,
    });
    for (const matches of [[], Array(21).fill(match)])
      expect(() => parseSearchMatchesPage({ matches, nextCursor: null })).toThrow();
    expect(() => parseSearchMatchesPage({ matches: [match], nextCursor: "more" })).toThrow();
    expect(() => parseSearchMatchesCursor(null)).toThrow();
  });
  it("页长的负极限统一为默认值，不能溢出原生整数边界", () => {
    const expr = { kind: "term", value: "archive" };
    expect(parseSearchQueryArgument({ expr, limit: -Number.MAX_VALUE }).limit).toBe(0);
  });
  it("末页以 null 结束，续页保留不透明游标", () => {
    expect(parseSearchPage({ hits: [hit], nextCursor: "cursor" })).toEqual({
      hits: [hit],
      nextCursor: "cursor",
    });
    expect(parseSearchPage({ hits: [], nextCursor: null })).toEqual({ hits: [], nextCursor: null });
  });

  it.each(
    [
      [],
      { hits: [hit] },
      { hits: [hit, hit], nextCursor: null },
      { hits: [], nextCursor: "cursor" },
      { hits: [hit], nextCursor: "" },
      { hits: [hit], nextCursor: "x".repeat(8193) },
    ].map((value) => [value]),
  )("拒绝损坏的页面 %#", (value) => {
    expect(() => parseSearchPage(value)).toThrow();
  });

  it("请求 ID 与游标在原生层之前校验，UTF-8 字节上限一致", () => {
    expect(parseSearchId("search-123")).toBe("search-123");
    for (const value of [null, "", "x".repeat(129), "../escape"])
      expect(() => parseSearchId(value)).toThrow();
    expect(parseSearchCursor(null)).toBeNull();
    expect(() => parseSearchCursor("中".repeat(3000))).toThrow();
  });
});
