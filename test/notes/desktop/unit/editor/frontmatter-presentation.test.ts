import { describe, expect, it } from "vitest";
import { AllSelection, EditorState, TextSelection } from "prosemirror-state";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { search, SearchQuery, setSearchState } from "prosemirror-search";
import { baseKeymap } from "prosemirror-commands";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { documentSchema } from "@reader/shared/markdown/schema";
import {
  bodySelection,
  frontmatterBlock,
  frontmatterPresentation,
} from "@reader/renderer/editor/frontmatter";
import { searchMatches } from "@reader/renderer/editor/search/search-navigation";
import { replaceSearch } from "@reader/renderer/editor/search/search-replace";

const metadata = "---\ncssclasses:\n  - nndl-bilingual\n---";

function stateFor(source: string): EditorState {
  const doc = parseMarkdown(source);
  return EditorState.create({
    doc,
    selection: bodySelection(doc),
    plugins: [frontmatterPresentation(), history(), search()],
  });
}

describe("属性与正文的呈现边界", () => {
  it("初始焦点和全选属于正文，替换正文不修改隐藏属性", () => {
    let state = stateFor(`${metadata}\n\n# 标题\n\n正文。\n`);
    const block = state.doc.firstChild!;
    expect(state.selection.from).toBe(block.nodeSize + 1);
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe("标题正文。");
    state = state.apply(state.tr.insertText("新的正文。"));
    expect(state.doc.firstChild?.eq(block)).toBe(true);
    expect(state.doc.lastChild?.textContent).toBe("新的正文。");
  });

  it("正文开头退格与越界事务不能更改属性，正文仍可撤销和重做", () => {
    let state = stateFor(`${metadata}\n\n# 标题\n`);
    const original = state.doc;
    baseKeymap.Backspace!(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(original)).toBe(true);
    state = state.apply(state.tr.delete(0, original.firstChild!.nodeSize));
    expect(state.doc.eq(original)).toBe(true);
    const changed = documentSchema.node(
      "markdown_block",
      null,
      documentSchema.text("---\nstatus: done\n---"),
    );
    state = state.apply(state.tr.replaceWith(0, original.firstChild!.nodeSize, changed));
    expect(state.doc.eq(original)).toBe(true);
    state = state.apply(closeHistory(state.tr.insertText("新的正文")));
    expect(frontmatterBlock(state.doc)?.text).toBe(metadata);
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(original)).toBe(true);
    redo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(frontmatterBlock(state.doc)?.text).toBe(metadata);
    expect(state.doc.lastChild?.textContent).toContain("新的正文");
  });

  it("文内查找与替换只处理正文，属性中的同名文字不计入命中", () => {
    let state = stateFor(`${metadata}\n\n正文 cssclasses。\n`);
    state = state.apply(
      setSearchState(state.tr, new SearchQuery({ search: "cssclasses", replace: "属性" })),
    );
    expect(searchMatches(state)).toHaveLength(1);
    replaceSearch(true)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(frontmatterBlock(state.doc)?.text).toBe(metadata);
    expect(state.doc.lastChild?.textContent).toBe("正文 属性。");
  });

  it.each([metadata, `\uFEFF${metadata.replace(/\n/g, "\r\n")}\r\n`])(
    "仅有属性的文件能直接写正文，打开与输入都保留原属性字节",
    (source) => {
      const session = createMarkdownSession(source);
      const state = EditorState.create({
        doc: session.doc,
        selection: bodySelection(session.doc),
        plugins: [frontmatterPresentation()],
      });
      expect(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(state.doc).bytes),
      ).toBe(source);
      const next = state.apply(state.tr.insertText("开始写作。"));
      const saved = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        session.snapshot(next.doc).bytes,
      );
      expect(saved.startsWith(source)).toBe(true);
      expect(saved).toContain("开始写作。");
      expect(parseMarkdown(saved.replace(/^\uFEFF/, "")).eq(next.doc)).toBe(true);
    },
  );

  it("源码视图交回的属性选区落在正文，普通围栏代码与分隔线保持可编辑", () => {
    const doc = parseMarkdown(`${metadata}\n\n正文。\n`);
    expect(bodySelection(doc, TextSelection.create(doc, 2)).from).toBe(
      doc.firstChild!.nodeSize + 1,
    );
    for (const source of ["```yaml\ncssclasses: demo\n```\n", "---\n\n正文。\n", "---\n未闭合\n"]) {
      const state = stateFor(source);
      expect(frontmatterBlock(state.doc)).toBeNull();
      expect(state.apply(state.tr.insertText("测试")).doc.eq(state.doc)).toBe(false);
    }
  });
});
