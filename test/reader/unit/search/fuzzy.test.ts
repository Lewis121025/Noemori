import { describe, expect, it } from "vitest";
import { fuzzyScore, rankByFuzzy, subsequenceSpan } from "@reader/renderer/engine/search/fuzzy";

describe("fuzzyScore 打分规则", () => {
  it("子串命中恒高于子序列命中", () => {
    const substring = fuzzyScore("note", "zzzzzzzzzzzzzzzzzzzz-note");
    const subsequence = fuzzyScore("note", "n-o-t-e");
    expect(substring).not.toBeNull();
    expect(subsequence).not.toBeNull();
    expect(substring!).toBeGreaterThan(subsequence!);
  });

  it("词首分隔符之后的子串额外加分", () => {
    expect(fuzzyScore("be", "notes/beta", "/")).toBe(1000 - 6 + 300);
    expect(fuzzyScore("be", "notes/beta")).toBe(1000 - 6);
    expect(fuzzyScore("no", "notes")).toBe(1000 + 300);
  });

  it("子序列按跨度打分，未命中返回 null", () => {
    expect(subsequenceSpan("a-b-c", "abc")).toBe(5);
    expect(fuzzyScore("abc", "a-b-c")).toBe(500 - 5);
    expect(fuzzyScore("xyz", "abc")).toBeNull();
    expect(subsequenceSpan("abc", "")).toBeNull();
  });
});

describe("rankByFuzzy 多键排序", () => {
  const items = [
    { id: "a", keys: ["Alpha", "甲"] },
    { id: "b", keys: ["Beta"] },
    { id: "c", keys: ["Gamma", "alpha 别名"] },
  ];
  const keys = (item: (typeof items)[number]) => item.keys;

  it("空查询保持输入顺序并截断", () => {
    expect(rankByFuzzy("  ", items, keys, 2).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("取各键最高分、大小写不敏感，同分保持输入顺序", () => {
    expect(rankByFuzzy("ALPHA", items, keys, 10).map((item) => item.id)).toEqual(["a", "c"]);
    expect(rankByFuzzy("甲", items, keys, 10).map((item) => item.id)).toEqual(["a"]);
  });

  it("未命中的条目被过滤", () => {
    expect(rankByFuzzy("zzz", items, keys, 10)).toEqual([]);
  });
});
