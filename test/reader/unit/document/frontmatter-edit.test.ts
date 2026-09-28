import { describe, expect, it } from "vitest";
import {
  addEntry,
  frontmatterBlock,
  frontmatterEntries,
  removeEntry,
  setEntryValue,
} from "@reader/renderer/engine/document/frontmatter-edit";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";

const sample = [
  "---",
  "title: 设计",
  "status: draft # 进行中",
  "tags: [a, b]",
  "author:",
  "  name: 张三",
  "empty:",
  "---",
].join("\n");

describe("frontmatterEntries", () => {
  it("标量/流式可编辑，块级结构只读，null 值键可编辑", () => {
    expect(frontmatterEntries(sample)).toEqual([
      { key: "title", value: "设计", editable: true },
      { key: "status", value: "draft", editable: true },
      { key: "tags", value: "[a, b]", editable: true },
      { key: "author", value: "", editable: false },
      { key: "empty", value: "", editable: true },
    ]);
  });

  it("引号值去引号展示，引号内的 # 与 : 属于值", () => {
    const text = ["---", 'a: "含: 冒号"', "b: 'has # hash'", "---"].join("\n");
    expect(frontmatterEntries(text)).toEqual([
      { key: "a", value: "含: 冒号", editable: true },
      { key: "b", value: "has # hash", editable: true },
    ]);
  });

  it("非法块返回空列表", () => {
    expect(frontmatterEntries("没有围栏\n")).toEqual([]);
    expect(frontmatterEntries("---\n没有闭合\n")).toEqual([]);
  });
});

describe("setEntryValue", () => {
  it("只替换值段，尾注释与其余行逐字节保留", () => {
    const next = setEntryValue(sample, "status", "done");
    expect(next).not.toBeNull();
    const lines = (next ?? "").split("\n");
    expect(lines[2]).toBe("status: done # 进行中");
    expect(lines[1]).toBe("title: 设计");
    expect(lines[4]).toBe("author:");
    expect(lines[5]).toBe("  name: 张三");
  });

  it("需要时自动加引号，块级键拒绝编辑", () => {
    expect(setEntryValue(sample, "title", "含: 冒号")?.split("\n")[1]).toBe('title: "含: 冒号"');
    expect(setEntryValue(sample, "title", "")?.split("\n")[1]).toBe('title: ""');
    expect(setEntryValue(sample, "author", "x")).toBeNull();
    expect(setEntryValue(sample, "缺席", "x")).toBeNull();
  });
});

describe("removeEntry", () => {
  it("块级键连同缩进延续行一起删除", () => {
    const next = removeEntry(sample, "author");
    expect(next).not.toContain("author:");
    expect(next).not.toContain("name: 张三");
    expect(next).toContain("status: draft # 进行中");
  });

  it("删除最后一个键返回空串，交由调用方移除整块", () => {
    expect(removeEntry("---\nonly: 1\n---", "only")).toBe("");
    expect(removeEntry(sample, "缺席")).toBeNull();
  });
});

describe("addEntry", () => {
  it("在闭合围栏前插行；没有 frontmatter 时生成新块", () => {
    const next = addEntry(sample, "due", "明天");
    const lines = (next ?? "").split("\n");
    expect(lines[7]).toBe("due: 明天");
    expect(lines[8]).toBe("---");
    expect(addEntry(null, "k", "v")).toBe("---\nk: v\n---");
  });

  it("重复键与非法键名被拒绝", () => {
    expect(addEntry(sample, "title", "x")).toBeNull();
    expect(addEntry(sample, "a:b", "x")).toBeNull();
    expect(addEntry(sample, "- x", "v")).toBeNull();
    expect(addEntry(sample, "", "v")).toBeNull();
  });
});

describe("CRLF 文件的混合换行形态逐字节保留", () => {
  // 解析产物形态：围栏联接是 \n，值内部行保留 \r\n，最后内容行不带 \r。
  const mixed = "---\nstatus: draft # 进行中\r\ntags: [project]\r\nauthor:\r\n  name: 张三\n---";

  it("条目在混合形态下照常解析", () => {
    expect(frontmatterEntries(mixed).map((entry) => entry.key)).toEqual([
      "status",
      "tags",
      "author",
    ]);
  });

  it("改中间行保留其 \\r，改最后内容行不添加 \\r", () => {
    const next = setEntryValue(mixed, "status", "done");
    expect(next?.split("\n")[1]).toBe("status: done # 进行中\r");
    expect(next?.split("\n")[3]).toBe("author:\r");
    expect(next?.split("\n")[4]).toBe("  name: 张三");
  });

  it("增键：原最后内容行补 \\r，新行不带 \\r，与再解析形态一致", () => {
    const next = addEntry(mixed, "due", "明天");
    expect(next).toBe(
      "---\nstatus: draft # 进行中\r\ntags: [project]\r\nauthor:\r\n  name: 张三\r\ndue: 明天\n---",
    );
  });

  it("删末位块级键：新的最后内容行交出 \\r", () => {
    const next = removeEntry(mixed, "author");
    expect(next).toBe("---\nstatus: draft # 进行中\r\ntags: [project]\n---");
  });

  it("删中间键不影响其余行的换行形态", () => {
    const next = removeEntry(mixed, "tags");
    expect(next).toBe("---\nstatus: draft # 进行中\r\nauthor:\r\n  name: 张三\n---");
  });
});

describe("frontmatterBlock", () => {
  it("识别文档首块的 YAML，编辑后往返一致", () => {
    const doc = parseMarkdown(`${sample}\n\n# 标题\n`);
    const block = frontmatterBlock(doc);
    expect(block?.text).toBe(sample);
    const edited = setEntryValue(sample, "status", "done");
    expect(edited).not.toBeNull();
    const reparsed = frontmatterBlock(parseMarkdown(`${edited}\n\n# 标题\n`));
    expect(reparsed?.text).toBe(edited);
  });

  it("没有 frontmatter 或以其它源码块开头的文档返回 null", () => {
    expect(frontmatterBlock(parseMarkdown("# 标题\n"))).toBeNull();
  });
});
