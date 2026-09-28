import { describe, expect, it } from "vitest";
import {
  isEmptyQuery,
  parseSearchQuery,
  SEARCH_LIMIT,
  snippetParts,
} from "@reader/renderer/search/query";
import {
  parseSearchQueryArgument,
  SEARCH_DEPTH_LIMIT,
  SEARCH_NODE_LIMIT,
} from "@reader/shared/reader-protocol";

const expr = (text: string) => parseSearchQuery(text).expr;
const term = (value: string) => ({ kind: "term", value });

describe("parseSearchQuery 基础语法", () => {
  it("空白分隔成 AND，单个条件直接返回，容忍多余空白", () => {
    expect(expr("  alpha   beta ")).toEqual({
      kind: "and",
      children: [term("alpha"), term("beta")],
    });
    expect(expr("全文")).toEqual(term("全文"));
    expect(parseSearchQuery("alpha").limit).toBe(SEARCH_LIMIT);
  });

  it("引号内按字面处理：空格成词、双引号折叠、不解析谓词与运算符", () => {
    expect(expr('"tag:not-a-predicate" "a ""b"" c" "OR"')).toEqual({
      kind: "and",
      children: [term("tag:not-a-predicate"), term('a "b" c'), term("OR")],
    });
  });

  it("tag: 与 # 前缀成为标签谓词，# 前缀被剥掉；孤立 # 按字面", () => {
    expect(expr("tag:project #inline tags:#draft")).toEqual({
      kind: "and",
      children: [
        { kind: "tag", value: "project" },
        { kind: "tag", value: "inline" },
        { kind: "tag", value: "draft" },
      ],
    });
    expect(expr("#")).toEqual(term("#"));
  });

  it("path: 与 file: 可重复，引号内的值保留空格", () => {
    expect(expr('path:notes/ path:"my docs" file:日记')).toEqual({
      kind: "and",
      children: [
        { kind: "path", value: "notes/" },
        { kind: "path", value: "my docs" },
        { kind: "file", value: "日记" },
      ],
    });
  });

  it("key:value 与 [键]/[键:值] 成为属性谓词；URL 与空值保持字面", () => {
    expect(expr("status:draft [author] [type: 书] https://example.com 时间: :lonely")).toEqual({
      kind: "and",
      children: [
        { kind: "attr", key: "status", value: "draft" },
        { kind: "attr", key: "author", value: null },
        { kind: "attr", key: "type", value: "书" },
        term("https://example.com"),
        term("时间:"),
        term(":lonely"),
      ],
    });
    expect(expr("[[wiki]]")).toEqual(term("[[wiki]]"));
  });

  it("空文本与只有运算符的文本不产生条件", () => {
    expect(isEmptyQuery(parseSearchQuery("   "))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery("OR ( ) -"))).toBe(false);
    expect(isEmptyQuery(parseSearchQuery("OR ()"))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery("tag:x"))).toBe(false);
  });
});

describe("parseSearchQuery 运算符", () => {
  it("OR 优先级低于 AND，括号分组", () => {
    expect(expr("a b OR c")).toEqual({
      kind: "or",
      children: [{ kind: "and", children: [term("a"), term("b")] }, term("c")],
    });
    expect(expr("a (b OR c)")).toEqual({
      kind: "and",
      children: [term("a"), { kind: "or", children: [term("b"), term("c")] }],
    });
    // 小写 or 是普通词。
    expect(expr("a or b")).toEqual({ kind: "and", children: [term("a"), term("or"), term("b")] });
  });

  it("- 前缀取反；词中的连字符不是取反", () => {
    expect(expr("-draft self-host -(a OR b)")).toEqual({
      kind: "and",
      children: [
        { kind: "not", child: term("draft") },
        term("self-host"),
        { kind: "not", child: { kind: "or", children: [term("a"), term("b")] } },
      ],
    });
  });

  it("/正则/ 可以包含空格与转义斜杠，未闭合按字面", () => {
    expect(expr("/a b\\/c+/ x")).toEqual({
      kind: "and",
      children: [{ kind: "regex", value: "a b/c+" }, term("x")],
    });
    expect(expr("/unclosed")).toEqual(term("/unclosed"));
  });

  it("line:( ) 与 section:( ) 限定作用域，也可只跟一个词", () => {
    expect(expr("line:(foo bar) section:(标题 -草稿) line:单词")).toEqual({
      kind: "and",
      children: [
        { kind: "line", child: { kind: "and", children: [term("foo"), term("bar")] } },
        {
          kind: "section",
          child: { kind: "and", children: [term("标题"), { kind: "not", child: term("草稿") }] },
        },
        { kind: "line", child: term("单词") },
      ],
    });
  });

  it("括号不配对时降级而不抛错", () => {
    expect(expr("(a b")).toEqual({ kind: "and", children: [term("a"), term("b")] });
    expect(expr("a ) b")).toEqual({ kind: "and", children: [term("a"), term("b")] });
  });
});

describe("parseSearchQuery 复杂度边界", () => {
  it.each(["-", "(", "line:(", "section:("])(
    "大量 %s 嵌套在进入递归前报告查询错误，不抛栈溢出",
    (prefix) => {
      const suffix = prefix === "-" ? "" : ")".repeat(10_000);
      expect(() => parseSearchQuery(`${prefix.repeat(10_000)}alpha${suffix}`)).toThrow(
        "检索条件嵌套过深",
      );
    },
  );

  it("深度上限处能通过跨进程校验，多一层拒绝", () => {
    const query = parseSearchQuery(`${"-".repeat(SEARCH_DEPTH_LIMIT)}alpha`);
    expect(parseSearchQueryArgument(query)).toEqual(query);
    expect(() => parseSearchQuery(`${"-".repeat(SEARCH_DEPTH_LIMIT + 1)}alpha`)).toThrow(
      "检索条件嵌套过深",
    );
    // OR 本身也是表达式节点，不能只限制前缀或括号的语法层数。
    expect(() => parseSearchQuery(`${"-".repeat(SEARCH_DEPTH_LIMIT)}alpha OR beta`)).toThrow(
      "检索条件嵌套过深",
    );
  });

  it("节点预算包含组合节点，达到上限可用、超出立即拒绝", () => {
    const text = Array.from({ length: SEARCH_NODE_LIMIT - 1 }, (_, index) => `词${index}`).join(
      " ",
    );
    const query = parseSearchQuery(text);
    expect(parseSearchQueryArgument(query)).toEqual(query);
    expect(() => parseSearchQuery(`${text} 超额`)).toThrow("检索条件过于复杂");
  });

  it("字面引号与正则中的括号、减号不消耗嵌套预算", () => {
    const literal = "(-".repeat(SEARCH_DEPTH_LIMIT + 1);
    expect(expr(`"${literal}"`)).toEqual(term(literal));
    const pattern = "(a)".repeat(SEARCH_DEPTH_LIMIT + 1);
    expect(expr(`/${pattern}/`)).toEqual({ kind: "regex", value: pattern });
  });
});

describe("snippetParts", () => {
  it("按控制字符切分高亮与普通片段", () => {
    expect(snippetParts("before\u{1}hit\u{2}after")).toEqual([
      { text: "before", mark: false },
      { text: "hit", mark: true },
      { text: "after", mark: false },
    ]);
    expect(snippetParts("plain")).toEqual([{ text: "plain", mark: false }]);
    expect(snippetParts("")).toEqual([]);
  });

  it("不成对标记不丢正文", () => {
    expect(snippetParts("a\u{1}b")).toEqual([
      { text: "a", mark: false },
      { text: "b", mark: true },
    ]);
  });
});
