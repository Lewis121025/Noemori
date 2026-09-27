import { expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { readInlineMarkStates } from "@reader/renderer/engine/editing/inline-formatting";

it.each([
  ["**全段**", true],
  ["**部分**正文", "mixed"],
  ["正文", false],
  ["**前段**\n\n后段", "mixed"],
  ["**正文**\n\n```\n代码不带样式\n```", true],
] as const)("读取 %s 的加粗状态为 %s", (source, expected) => {
  const doc = parseMarkdown(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, doc.content.size - 1),
  });
  expect(readInlineMarkStates(state).strong).toBe(expected);
});

it("只检查实际选中的文本，边缘空白不产生错误的混合状态", () => {
  const doc = parseMarkdown("普通文字 **加粗** 普通文字");
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 5, 9) });
  expect(doc.textBetween(5, 9)).toBe(" 加粗 ");
  expect(readInlineMarkStates(state).strong).toBe(true);
});

it("一次读取多种叠加样式，互不干扰", () => {
  const doc = parseMarkdown("***重点*** ~~删除~~ ==高亮== `代码`");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, doc.content.size - 1),
  });
  expect(readInlineMarkStates(state)).toEqual({
    strong: "mixed",
    em: "mixed",
    strike: "mixed",
    highlight: "mixed",
    code: "mixed",
  });
});

it("光标的待输入样式优先于正文样式，空样式明确表示取消", () => {
  const doc = parseMarkdown("**正文**");
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
  expect(readInlineMarkStates(state).strong).toBe(true);
  state = state.apply(state.tr.setStoredMarks([]));
  expect(readInlineMarkStates(state).strong).toBe(false);
  state = state.apply(state.tr.addStoredMark(state.schema.marks.em!.create()));
  expect(readInlineMarkStates(state).em).toBe(true);
});
