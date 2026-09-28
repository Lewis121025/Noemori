import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/markdown/markdown";
import { documentSchema } from "@reader/renderer/markdown/schema";
import { suggestRequest } from "@reader/renderer/editor/links/suggestions/context";
import { suggestInsertion } from "@reader/renderer/editor/links/suggestions/insert";
import {
  rankBlockCandidates,
  rankFileCandidates,
  rankHeadingCandidates,
  SUGGESTION_LIMIT,
} from "@reader/renderer/editor/links/suggestions/candidates";

/** 单段落文档末尾光标的状态；触发识别只依赖光标前的文本运行。 */
function stateAtEnd(source: string): EditorState {
  const doc = parseMarkdown(source);
  return EditorState.create({
    doc,
    selection: TextSelection.atEnd(doc),
  });
}

/** 光标落在文档指定位置的状态。 */
function stateAt(source: string, pos: number): EditorState {
  const doc = parseMarkdown(source);
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

/**
 * 直接以字面文本建段：模拟「用户刚敲出来的字符」，
 * 转义反斜杠此时还在文本里，未经过 Markdown 往返。
 */
function stateWithText(text: string): EditorState {
  const doc = documentSchema.node("doc", null, [
    documentSchema.node("paragraph", null, text === "" ? [] : [documentSchema.text(text)]),
  ]);
  return EditorState.create({ doc, selection: TextSelection.atEnd(doc) });
}

describe("suggestRequest 触发识别", () => {
  it("wiki 语法：空查询、路径查询与锚点查询", () => {
    expect(suggestRequest(stateAtEnd("[["))).toEqual({
      kind: "file",
      syntax: "wiki",
      from: 3,
      triggerFrom: 1,
      query: "",
      closeAfter: false,
      labelStart: null,
    });
    expect(suggestRequest(stateAtEnd("[[notes/be"))).toMatchObject({
      kind: "file",
      syntax: "wiki",
      query: "notes/be",
    });
    expect(suggestRequest(stateAtEnd("[[note#he"))).toEqual({
      kind: "heading",
      syntax: "wiki",
      from: 8,
      triggerFrom: 1,
      query: "he",
      target: "note",
      closeAfter: false,
      labelStart: null,
    });
  });

  it("#^ 进入块查询，空目标表示本笔记", () => {
    expect(suggestRequest(stateAtEnd("[[note#^ab"))).toMatchObject({
      kind: "block",
      syntax: "wiki",
      query: "ab",
      target: "note",
      from: 9,
    });
    expect(suggestRequest(stateAtEnd("[[#^"))).toMatchObject({
      kind: "block",
      target: "",
      query: "",
    });
  });

  it("Markdown 语法：目标与锚点，并给出配对标签起点", () => {
    expect(suggestRequest(stateAtEnd("[label](./pa"))).toMatchObject({
      kind: "file",
      syntax: "md",
      query: "./pa",
      labelStart: 1,
    });
    expect(suggestRequest(stateAtEnd("[label](./note.md#se"))).toMatchObject({
      kind: "heading",
      syntax: "md",
      query: "se",
      target: "./note.md",
      labelStart: 1,
    });
  });

  it("光标后已有闭合语法时不再补闭合", () => {
    // 转义源保证 "[[inside]]" 以纯文本入文；光标在 inside 之后（pos 9），后随 "]]"。
    const request = suggestRequest(stateAt("\\[[inside]]", 9));
    expect(request).toMatchObject({ kind: "file", query: "inside", closeAfter: true });
  });

  it("已闭合链接之后、别名段、外部 URL 都不触发", () => {
    expect(suggestRequest(stateAtEnd("[[done]]"))).toBeNull();
    expect(suggestRequest(stateAtEnd("[[note|al"))).toBeNull();
    expect(suggestRequest(stateAtEnd("[x](https://ex"))).toBeNull();
  });

  it("转义的 \\[[ 是字面文本，不触发", () => {
    // 用户刚敲出的反斜杠仍在文本里：奇数转义不触发，偶数是字面反斜杠后有效触发。
    expect(suggestRequest(stateWithText("\\[[x"))).toBeNull();
    expect(suggestRequest(stateWithText("\\\\[[x"))).not.toBeNull();
  });

  it("代码块与行内代码里的链接语法是字面文本", () => {
    expect(suggestRequest(stateAtEnd("```text\n[[x\n```"))).toBeNull();
    // "a `[[x` b"：行内代码内 pos 5。
    expect(suggestRequest(stateAt("a `[[x` b", 5))).toBeNull();
  });

  it("非空选区与块外光标不触发", () => {
    const doc = parseMarkdown("[[x");
    const range = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 4),
    });
    expect(suggestRequest(range)).toBeNull();
  });
});

describe("rankFileCandidates", () => {
  const files = ["notes/alpha.md", "notes/beta.md", "beta-two.md", "其它/伽马.md"];

  it("子串命中优先，文件名与段开头加分", () => {
    const items = rankFileCandidates("beta", files);
    expect(items.map((item) => item.detail)).toEqual(["beta-two.md", "notes/beta.md"]);
    // 插入值去掉 .md；主行展示文件名。
    expect(items[0]).toEqual({ value: "beta-two", label: "beta-two", detail: "beta-two.md" });
    expect(items[1]).toEqual({ value: "notes/beta", label: "beta", detail: "notes/beta.md" });
  });

  it("子序列模糊命中排在子串之后", () => {
    const items = rankFileCandidates("nba", files);
    expect(items.map((item) => item.detail)).toEqual(["notes/beta.md"]);
  });

  it("CJK 查询与大小写不敏感", () => {
    expect(rankFileCandidates("伽马", files).map((item) => item.value)).toEqual(["其它/伽马"]);
    expect(rankFileCandidates("ALPHA", files).map((item) => item.value)).toEqual(["notes/alpha"]);
  });

  it("空查询按路径顺序返回，超过上限截断", () => {
    const many = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, "0")}.md`);
    const items = rankFileCandidates("", many);
    expect(items).toHaveLength(SUGGESTION_LIMIT);
    expect(items[0]?.value).toBe("f00");
  });

  it("没有命中返回空列表", () => {
    expect(rankFileCandidates("zzz", files)).toEqual([]);
  });

  it("有查询时别名参与匹配，插入目标路径并带别名；空查询不列别名", () => {
    const notes = [
      { path: "notes/beta.md", title: "beta", aliases: ["乙", "Second"] },
      { path: "gone.md", title: "gone", aliases: ["乙号"] },
    ];
    expect(rankFileCandidates("乙", files, notes)).toEqual([
      { value: "notes/beta", label: "乙", detail: "别名 · notes/beta.md", alias: "乙" },
    ]);
    expect(rankFileCandidates("sec", files, notes)[0]?.alias).toBe("Second");
    expect(rankFileCandidates("", files, notes).some((item) => item.alias !== undefined)).toBe(
      false,
    );
  });
});

describe("rankBlockCandidates", () => {
  const blocks = [
    { index: 0, text: "第一段内容", id: null, insertAt: 5 },
    { index: 1, text: "第二段", id: "keep-1", insertAt: 12 },
  ];

  it("按块文字与已有 ID 匹配，value 是块序号，副行区分是否需要写入 ID", () => {
    expect(rankBlockCandidates("", blocks).map((item) => item.value)).toEqual(["0", "1"]);
    expect(rankBlockCandidates("keep", blocks)).toEqual([
      { value: "1", label: "第二段", detail: "^keep-1" },
    ]);
    expect(rankBlockCandidates("第一", blocks)[0]?.detail).toBe("块 · 将写入新 ID");
  });
});

describe("rankHeadingCandidates", () => {
  const headings = ["引言", "深入小节", "深入 附录", "小结"];

  it("空查询保持文档顺序", () => {
    expect(rankHeadingCandidates("", headings).map((item) => item.value)).toEqual(headings);
  });

  it("子串命中按文档顺序，未命中的不出现", () => {
    expect(rankHeadingCandidates("深入", headings).map((item) => item.value)).toEqual([
      "深入小节",
      "深入 附录",
    ]);
    expect(rankHeadingCandidates("深入", headings)[0]?.detail).toBe("标题");
  });

  it("value 是标题原文，命中越靠前排越前", () => {
    expect(rankHeadingCandidates("小", headings).map((item) => item.value)).toEqual([
      "小结",
      "深入小节",
    ]);
  });
});

describe("suggestInsertion 提交事务", () => {
  function choose(state: EditorState, value: string): EditorState {
    const request = suggestRequest(state);
    if (request === null) throw new Error("未触发补全");
    const tr = suggestInsertion(state, request, value);
    if (tr === null) throw new Error("事务为空");
    return state.apply(tr);
  }

  it("wiki 候选落成原子节点，序列化为干净链接语法，光标落在链接后", () => {
    const next = choose(stateAtEnd("see [[b/fo"), "b/foo");
    expect(serializeMarkdown(next.doc)).toBe("see [[b/foo]]\n");
    expect(next.doc.nodeAt(next.selection.from - 1)?.type.name).toBe("wiki_link");
    expect(next.selection.empty).toBe(true);
  });

  it("wiki 锚点候选拼出完整目标", () => {
    const next = choose(stateAtEnd("[[note#he"), "深入小节");
    expect(serializeMarkdown(next.doc)).toBe("[[note#深入小节]]\n");
  });

  it("md 候选把已输入的标签文本转为链接标记", () => {
    const next = choose(stateAtEnd("[label](./pa"), "notes/page.md");
    expect(serializeMarkdown(next.doc)).toBe("[label](notes/page.md)\n");
    expect(next.selection.empty).toBe(true);
  });

  it("光标后已有闭合语法时一并消费，不残留字面括号", () => {
    // 转义源使 "[[inside]]" 以纯文本入文；光标在 inside 之后、"]]" 之前。
    const next = choose(stateAt("\\[[inside]]", 9), "done");
    expect(serializeMarkdown(next.doc)).toBe("[[done]]\n");
  });

  it("没有配对标签括号时退回文本插入，与手敲语义一致", () => {
    const next = choose(stateAtEnd("see ](pa"), "x.md");
    expect(next.doc.textContent).toBe("see ](x.md)");
  });

  it("md 锚点候选保留原标签文字", () => {
    const next = choose(stateAtEnd("[原标签](./note.md#se"), "小节");
    expect(serializeMarkdown(next.doc)).toBe("[原标签](./note.md#小节)\n");
  });

  it("块候选拼出 #^ID；别名候选写成带显示名的链接", () => {
    expect(serializeMarkdown(choose(stateAtEnd("[[note#^ab"), "^abc123").doc)).toBe(
      "[[note#^abc123]]\n",
    );
    const state = stateAtEnd("[[乙");
    const request = suggestRequest(state)!;
    const aliased = state.apply(suggestInsertion(state, request, "notes/beta", "乙")!);
    expect(serializeMarkdown(aliased.doc)).toBe("[[notes/beta|乙]]\n");
    const md = stateAtEnd("[](./be");
    const mdAliased = md.apply(suggestInsertion(md, suggestRequest(md)!, "notes/beta.md", "乙")!);
    expect(serializeMarkdown(mdAliased.doc)).toBe("[乙](notes/beta.md)\n");
  });

  it("过期触发范围返回 null，不强行写入", () => {
    const state = stateAtEnd("[[abc");
    const request = suggestRequest(state);
    if (request === null) throw new Error("未触发补全");
    const stale = { ...request, from: state.doc.content.size + 10 };
    expect(suggestInsertion(state, stale, "x")).toBeNull();
  });
});
