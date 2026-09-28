import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { writingCommands } from "@reader/renderer/engine/editing/writing";
import { insertLink } from "@reader/renderer/engine/editing/link-editing";

describe("编辑命令的内容保真", () => {
  it.each(["[[参考|资料]]", "$x^2$", "![图](image.png)", "<kbd>按键</kbd>"])(
    "代码格式不吞掉选区中的 %s",
    (inline) => {
      for (const command of [writingCommands.code, writingCommands.codeBlock]) {
        const doc = parseMarkdown(`前 ${inline} 后\n`);
        let state = EditorState.create({
          doc,
          selection: TextSelection.create(doc, 1, doc.content.size - 1),
        });
        expect(command(state)).toBe(false);
        expect(
          command(state, (tr) => {
            state = state.apply(tr);
          }),
        ).toBe(false);
        expect(state.doc.eq(doc)).toBe(true);
      }
    },
  );

  it("光标所在段落含公式时，代码块转换也不能清除选区外的公式", () => {
    const state = EditorState.create({ doc: parseMarkdown("前 $x$ 后\n") });
    expect(writingCommands.codeBlock(state)).toBe(false);
  });

  it("正文与代码块互换保留显式换行", () => {
    const doc = parseMarkdown("第一行\\\n第二行\n");
    let state = EditorState.create({ doc });
    const dispatch = (tr: Transaction) => {
      state = state.apply(tr);
    };
    expect(writingCommands.codeBlock(state, dispatch)).toBe(true);
    expect(state.doc.firstChild?.textContent).toBe("第一行\n第二行");
    expect(parseMarkdown(serializeMarkdown(state.doc)).eq(state.doc)).toBe(true);
    writingCommands.paragraph(state, dispatch);
    expect(state.doc.eq(doc)).toBe(true);
  });

  it.each([
    '[原文字](https://example.com/ "保留标题")\n',
    '[原文字][ref]\n\n[ref]: https://example.com/ "保留标题"\n',
  ])("编辑显示文字保留链接标题与原引用形式：%s", (source) => {
    const doc = parseMarkdown(source);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) });
    insertLink(
      "https://example.com/",
      "新文字",
      "md",
    )(state, (tr) => {
      state = state.apply(tr);
    });
    const saved = serializeMarkdown(state.doc);
    expect(saved).toBe(source.replace("原文字", "新文字"));
    expect(parseMarkdown(saved).eq(state.doc)).toBe(true);
  });

  it("修改引用链接的地址只改当前链接，保留标题和其他引用", () => {
    const doc = parseMarkdown(
      '[原文字][ref] 和 [其他][ref]\n\n[ref]: https://example.com/ "保留标题"\n',
    );
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) });
    insertLink(
      "https://other.example/",
      "新文字",
      "md",
    )(state, (tr) => {
      state = state.apply(tr);
    });
    const saved = serializeMarkdown(state.doc);
    expect(saved).toContain('[新文字](https://other.example/ "保留标题")');
    expect(saved).toContain("[其他][ref]");
    expect(parseMarkdown(saved).eq(state.doc)).toBe(true);
  });

  it("链接文字可以设置行内代码，但代码块转换不能删除链接地址", () => {
    const doc = parseMarkdown('[文字](https://example.com/ "标题")\n');
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 3) });
    expect(writingCommands.codeBlock(state)).toBe(false);
    expect(
      writingCommands.code(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(serializeMarkdown(state.doc)).toBe('[`文字`](https://example.com/ "标题")\n');
    expect(parseMarkdown(serializeMarkdown(state.doc)).eq(state.doc)).toBe(true);
  });

  it("多段选区中只要有不能转换的内容，代码块转换就不部分提交", () => {
    const doc = parseMarkdown("正文\n\n含 $x$ 的段落\n");
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    });
    expect(
      writingCommands.codeBlock(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(false);
    expect(state.doc.eq(doc)).toBe(true);
  });
});
