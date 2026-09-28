import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { SearchQuery, search } from "prosemirror-search";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { replaceSearch } from "@reader/renderer/engine/editing/search-replace";

describe("替换命令的边界", () => {
  it("光标在文末时，替换先回到第一处，不静默失效", () => {
    let state = EditorState.create({
      doc: parseMarkdown("目标\n"),
      plugins: [search({ initialQuery: new SearchQuery({ search: "目标", replace: "新词" }) })],
    });
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    expect(
      replaceSearch(false)(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe("目标");
    expect(serializeMarkdown(state.doc)).toBe("目标\n");
  });

  it("替换文本中的美元符号按字面量处理，空字符串能删除匹配", () => {
    for (const replacement of ["$&$1", ""]) {
      let state = EditorState.create({
        doc: parseMarkdown("a x b\n"),
        plugins: [
          search({
            initialQuery: new SearchQuery({ search: "x", replace: replacement, literal: true }),
          }),
        ],
      });
      replaceSearch(true)(state, (tr) => {
        state = state.apply(tr);
      });
      expect(state.doc.textContent).toBe(`a ${replacement} b`);
    }
  });

  it("空查询和没有命中时不提交事务", () => {
    for (const term of ["", "不存在"]) {
      const state = EditorState.create({
        doc: parseMarkdown("正文\n"),
        plugins: [search({ initialQuery: new SearchQuery({ search: term }) })],
      });
      expect(
        replaceSearch(true)(state, () => {
          throw new Error("不应改动正文");
        }),
      ).toBe(false);
    }
  });

  it("手动选中重叠文字时先定位高亮命中，不替换未计入结果的重叠范围", () => {
    let state = EditorState.create({
      doc: parseMarkdown("aaaaa\n"),
      plugins: [search({ initialQuery: new SearchQuery({ search: "aa", replace: "X" }) })],
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 4)));
    replaceSearch(false)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textContent).toBe("aaaaa");
    expect(state.selection.from).toBe(1);
    expect(state.selection.to).toBe(3);
    replaceSearch(true)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textContent).toBe("XXa");
  });
});
