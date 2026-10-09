import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { serializeMarkdown } from "@reader/shared/markdown/serialize";
import {
  setTextColor,
  setHighlightColor,
  clearTextStyles,
} from "@reader/renderer/editor/text-style-commands";
import { documentAccess } from "@reader/renderer/editor/read-only";

function editor(source: string, from: number, to = from) {
  const doc = parseMarkdown(source);
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [history()],
  });
  return {
    get state() {
      return state;
    },
    dispatch(tr: Parameters<EditorState["apply"]>[0]) {
      state = state.apply(tr);
    },
  };
}

describe("文字样式命令", () => {
  it("黄色高亮不着色选区边缘空白，保存重开保持相同格式范围", () => {
    const e = editor("前 文字 后", 2, 6);
    expect(setHighlightColor("yellow")(e.state, e.dispatch)).toBe(true);
    expect(parseMarkdown(serializeMarkdown(e.state.doc)).eq(e.state.doc)).toBe(true);
    expect(serializeMarkdown(e.state.doc)).toBe("前 ==文字== 后\n");
  });

  it("混合选区统一着色，高亮与文字色叠加，保存与撤销保留选区", () => {
    const e = editor("**重点**正文", 1, 5);
    const selection = e.state.selection;
    const original = e.state.doc;
    expect(setTextColor("red")(e.state, e.dispatch)).toBe(true);
    expect(setHighlightColor("blue")(e.state, e.dispatch)).toBe(true);
    expect(e.state.selection.eq(selection)).toBe(true);
    expect(parseMarkdown(serializeMarkdown(e.state.doc)).eq(e.state.doc)).toBe(true);
    expect(e.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      "strong",
      "highlight",
      "text_color",
    ]);
    undo(e.state, e.dispatch);
    undo(e.state, e.dispatch);
    expect(e.state.doc.eq(original)).toBe(true);
    expect(e.state.selection.eq(selection)).toBe(true);
  });

  it("清除样式保留文字、链接与公式，只作用于选区", () => {
    const e = editor("<u>**[链接](note.md)** $x$</u> **后文**", 1, 5);
    expect(clearTextStyles(e.state, e.dispatch)).toBe(true);
    expect(e.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      "link",
    ]);
    expect(e.state.doc.firstChild?.lastChild?.marks.map((mark) => mark.type.name)).toEqual([
      "strong",
    ]);
    expect(e.state.doc.firstChild?.child(2).type.name).toBe("math_inline");
    expect(parseMarkdown(serializeMarkdown(e.state.doc)).eq(e.state.doc)).toBe(true);
  });

  it("光标颜色和清除只改变待输入样式，默认颜色不取消其他样式", () => {
    const e = editor("**正文**", 2);
    const original = e.state.doc;
    setTextColor("green")(e.state, e.dispatch);
    expect(e.state.storedMarks?.map((mark) => mark.type.name)).toEqual(["strong", "text_color"]);
    setTextColor(null)(e.state, e.dispatch);
    expect(e.state.storedMarks?.map((mark) => mark.type.name)).toEqual(["strong"]);
    clearTextStyles(e.state, e.dispatch);
    expect(e.state.storedMarks).toEqual([]);
    expect(clearTextStyles(e.state)).toBe(false);
    expect(e.state.doc.eq(original)).toBe(true);
  });

  it("已有提示块中的文字样式可编辑，保留类型、标题、折叠与内容，撤销完整恢复", () => {
    const e = editor("> [!custom]- 我的标题\n> **内容**", 2, 4);
    const original = e.state.doc;
    expect(setTextColor("red")(e.state, e.dispatch)).toBe(true);
    expect(e.state.doc.firstChild?.attrs).toEqual(original.firstChild?.attrs);
    expect(e.state.doc.textContent).toBe("内容");
    expect(
      e.state.doc.firstChild?.firstChild?.firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["strong", "text_color"]);
    expect(parseMarkdown(serializeMarkdown(e.state.doc)).eq(e.state.doc)).toBe(true);
    undo(e.state, e.dispatch);
    expect(e.state.doc.eq(original)).toBe(true);
  });

  it("代码与只读权限拒绝新增文字样式", () => {
    const e = editor("```\n代码\n```", 1, 3);
    expect(setTextColor("red")(e.state)).toBe(false);
    const state = EditorState.create({
      doc: parseMarkdown("正文"),
      plugins: [documentAccess(true)],
    });
    expect(setHighlightColor("blue")(state)).toBe(false);
  });
});
