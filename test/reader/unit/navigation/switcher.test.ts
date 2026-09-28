import { describe, expect, it } from "vitest";
import {
  SWITCHER_LIMIT,
  createNotePath,
  rankSwitcher,
  switcherEntries,
} from "@reader/renderer/engine/navigation/switcher";

const files = ["notes/alpha.md", "beta.md", "images/photo.png", "docs/manual.pdf"];
const keys = [
  { path: "notes/alpha.md", title: "Alpha 标题", aliases: ["甲"] },
  { path: "beta.md", title: "beta", aliases: [] },
];

describe("switcherEntries 候选构建", () => {
  it("Markdown 去扩展名显示，附件保留扩展名，身份键并入匹配", () => {
    const entries = switcherEntries(files, keys);
    expect(entries.map((entry) => entry.label)).toEqual([
      "alpha",
      "beta",
      "photo.png",
      "manual.pdf",
    ]);
    expect(entries[0]).toMatchObject({
      path: "notes/alpha.md",
      title: "Alpha 标题",
      aliases: ["甲"],
    });
    expect(entries[2]).toMatchObject({ path: "images/photo.png", title: null, aliases: [] });
  });

  it("身份键里已不存在的路径不产生候选", () => {
    expect(switcherEntries(["beta.md"], keys).map((entry) => entry.path)).toEqual(["beta.md"]);
  });
});

describe("rankSwitcher 排序", () => {
  const entries = switcherEntries(files, keys);

  it("空查询按最近打开排列，缺少最近记录时按路径补足", () => {
    const hits = rankSwitcher("", entries, ["beta.md", "gone.md", "notes/alpha.md"]);
    expect(hits.map((hit) => hit.entry.path)).toEqual([
      "beta.md",
      "notes/alpha.md",
      "images/photo.png",
      "docs/manual.pdf",
    ]);
    expect(hits.every((hit) => hit.alias === null)).toBe(true);
  });

  it("按文件名、路径、标题与别名匹配，别名命中带出别名", () => {
    expect(rankSwitcher("alpha", entries, []).map((hit) => hit.entry.path)).toEqual([
      "notes/alpha.md",
    ]);
    const byAlias = rankSwitcher("甲", entries, []);
    expect(byAlias).toEqual([{ entry: entries[0], alias: "甲" }]);
    expect(rankSwitcher("标题", entries, [])[0]?.entry.path).toBe("notes/alpha.md");
    expect(rankSwitcher("images/", entries, [])[0]?.entry.path).toBe("images/photo.png");
  });

  it("文件名命中优先于路径中段命中，结果截到上限", () => {
    const many = switcherEntries(
      Array.from({ length: SWITCHER_LIMIT + 10 }, (_, index) => `n${index}.md`),
      [],
    );
    expect(rankSwitcher("n", many, [])).toHaveLength(SWITCHER_LIMIT);
    const ordered = switcherEntries(["deep/beta-notes/x.md", "beta.md"], []);
    expect(rankSwitcher("beta", ordered, [])[0]?.entry.path).toBe("beta.md");
  });
});

describe("createNotePath 由查询生成新笔记路径", () => {
  it("补 .md 扩展名、去掉首尾空白与斜杠", () => {
    expect(createNotePath(" 新笔记 ")).toBe("新笔记.md");
    expect(createNotePath("目录/名字.md")).toBe("目录/名字.md");
    expect(createNotePath("/a/")).toBe("a.md");
    expect(createNotePath("   ")).toBeNull();
  });
});
