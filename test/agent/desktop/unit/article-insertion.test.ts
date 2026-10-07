import { expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { parseMarkdown } from "../../../../modules/notes/packages/desktop/src/features/reader/shared/markdown/parse";
import {
  conversationInsertion,
  conversationInsertionPlugin,
  conversationRange,
} from "../../../../modules/notes/packages/desktop/src/features/reader/renderer/editor/agent/insertion";

it("异步创建期间正文前方的编辑映射插入点，删除原位置后拒绝插到别处", () => {
  let state = EditorState.create({
    doc: parseMarkdown("原来的段落"),
    plugins: [conversationInsertionPlugin()],
  });
  state = state.apply(state.tr.setMeta(conversationInsertion, 4));
  state = state.apply(state.tr.insertText("新增", 1));
  expect(conversationInsertion.getState(state)).toBe(6);
  state = state.apply(state.tr.delete(1, 8));
  expect(conversationInsertion.getState(state)).toBeNull();
});

it("同一入口内的格式不是重复入口，不同段落中的重复入口不能任意定位", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const link = `[讨论**这一段**](noemori://conversation/${id})`;
  expect(conversationRange(parseMarkdown(link), id)).not.toBeNull();
  expect(conversationRange(parseMarkdown(`${link}\n\n${link}`), id)).toBeNull();
});
