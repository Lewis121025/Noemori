import { describe, expect, it } from "vitest";
import { AllSelection, EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, undoDepth } from "prosemirror-history";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import {
  headingSections,
  headingFolding,
  foldedHeadingRanges,
  toggleHeadingFold,
} from "@reader/renderer/editor/heading-fold";

const source = "# 第一章\n\n开篇。\n\n## 小节\n\n细节。\n\n# 第二章\n\n结尾。\n";
function fixture(text = source) {
  const session = createMarkdownSession(text);
  let state = EditorState.create({ doc: session.doc, plugins: [history(), headingFolding()] });
  const apply = (tr: Transaction) => {
    const result = state.applyTransaction(tr);
    result.transactions.forEach((transaction) => session.track(transaction));
    state = result.state;
  };
  return {
    state: () => state,
    toggle: (pos: number) => toggleHeadingFold(pos)(state, apply),
    apply,
    save: () =>
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(state.doc).bytes),
  };
}

describe("正文标题折叠", () => {
  it("章节到下一个同级或更高标题结束，嵌套容器的标题不越过自身范围", () => {
    const doc = parseMarkdown(source);
    const sections = headingSections(doc);
    expect(sections.map((section) => section.title)).toEqual(["第一章", "小节", "第二章"]);
    expect(sections[0]?.to).toBe(sections[2]?.pos);
    expect(sections[1]?.to).toBe(sections[2]?.pos);
    expect(sections[2]?.to).toBe(doc.content.size);
    const nested = headingSections(parseMarkdown("> ## 引用标题\n>\n> 引用内容\n\n外部正文\n"))[0]!;
    expect(nested.to).toBeLessThan(
      parseMarkdown("> ## 引用标题\n>\n> 引用内容\n\n外部正文\n").content.size,
    );
  });

  it("折叠仅改变显示，保留 BOM、换行、正文和撤销历史", () => {
    const text = "\uFEFF" + source.replace(/\n/g, "\r\n");
    const test = fixture(text);
    const before = test.state().doc;
    expect(test.toggle(0)).toBe(true);
    expect(foldedHeadingRanges(test.state())).toHaveLength(1);
    expect(test.state().doc.eq(before)).toBe(true);
    expect(test.save()).toBe(text);
    expect(undoDepth(test.state())).toBe(0);
    expect(test.toggle(0)).toBe(true);
    expect(foldedHeadingRanges(test.state())).toHaveLength(0);
  });

  it("折叠当前选区所在章节时将光标放回标题，展开父章节保留子章节折叠", () => {
    const test = fixture();
    const sections = headingSections(test.state().doc);
    const child = sections[1]!;
    test.apply(
      test.state().tr.setSelection(TextSelection.create(test.state().doc, child.from + 1)),
    );
    test.toggle(child.pos);
    expect(test.state().selection.$from.parent.type.name).toBe("heading");
    test.toggle(0);
    expect(foldedHeadingRanges(test.state())[0]?.from).toBe(sections[0]?.from);
    test.toggle(0);
    expect(foldedHeadingRanges(test.state())).toEqual([{ from: child.from, to: child.to }]);
  });

  it("定位隐藏文字时展开全部覆盖章节，全选也包含完整正文", () => {
    const test = fixture();
    const child = headingSections(test.state().doc)[1]!;
    test.toggle(child.pos);
    test.toggle(0);
    test.apply(
      test
        .state()
        .tr.setSelection(TextSelection.create(test.state().doc, child.from + 1))
        .scrollIntoView(),
    );
    expect(foldedHeadingRanges(test.state())).toHaveLength(0);
    test.toggle(0);
    test.apply(test.state().tr.setSelection(new AllSelection(test.state().doc)));
    expect(foldedHeadingRanges(test.state())).toHaveLength(0);
    expect(
      test.state().selection.content().content.textBetween(0, test.state().doc.content.size),
    ).toContain("细节");
  });

  it("前文插入后折叠跟随原标题，删除标题后不误折叠其他段落", () => {
    const test = fixture();
    const second = headingSections(test.state().doc)[2]!;
    test.toggle(second.pos);
    test.apply(
      test
        .state()
        .tr.insert(
          0,
          test.state().schema.node("paragraph", null, test.state().schema.text("前言")),
        ),
    );
    const shifted = headingSections(test.state().doc)[2]!;
    expect(foldedHeadingRanges(test.state())).toEqual([{ from: shifted.from, to: shifted.to }]);
    test.apply(test.state().tr.delete(shifted.pos, shifted.from));
    expect(foldedHeadingRanges(test.state())).toHaveLength(0);
  });

  it("空章节没有折叠动作，无关选区与搜索状态更新不会展开章节", () => {
    const empty = fixture("# 空标题\n\n# 另一个标题\n");
    expect(empty.toggle(0)).toBe(false);
    const test = fixture();
    test.toggle(0);
    const ranges = foldedHeadingRanges(test.state());
    test.apply(test.state().tr.setMeta("query", "关键词"));
    expect(foldedHeadingRanges(test.state())).toBe(ranges);
  });
});
