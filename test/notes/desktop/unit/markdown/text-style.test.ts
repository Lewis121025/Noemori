import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { serializeMarkdown } from "@reader/shared/markdown/serialize";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";

describe("可编辑文字样式的 Markdown 契约", () => {
  it.each([
    ["<u>下划线</u>", "underline", null],
    ['<span style="color: #b44343">红色</span>', "text_color", "red"],
    ['<mark style="background-color: #cde1f5">蓝色高亮</mark>', "highlight", "blue"],
    ["==黄色高亮==", "highlight", "yellow"],
  ])("%s 解析为可编辑文字，保存重开保留样式", (source, name, color) => {
    const doc = parseMarkdown(source);
    const text = doc.firstChild?.firstChild;
    expect(text?.isText).toBe(true);
    expect(text?.marks.map((mark) => mark.type.name)).toEqual([name]);
    if (color) expect(text?.marks[0]?.attrs["color"]).toBe(color);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });

  it.each([
    "<u>**加粗** [链接](note.md) `代码`</u>",
    '<span style="color: #b44343">外层 <span style="color: #356a9a">内层</span> 外层</span>',
    '<mark style="background-color: #f2d2df"><u>*组合* &amp; 转义 \\*</u></mark>',
    '<mark style="background-color: #f2d2df">==内层黄色==</mark>',
    '| 样式 |\n| --- |\n| <u>甲\\|乙</u> <span style="color: #7850a0">紫色</span> |',
  ])("嵌套格式、链接和表格语义可往返：%s", (source) => {
    const doc = parseMarkdown(source);
    let html = false;
    doc.descendants((node) => {
      if (node.type.name === "html_inline") html = true;
    });
    expect(html).toBe(false);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });

  it.each([
    '<u class="custom">文字</u>',
    '<span style="color: red; font-size: 24px">文字</span>',
    '<mark style="background-color: #123456">文字</mark>',
    "<u>未闭合",
    '<u><span style="color: #b44343">交叉闭合</u></span>',
    '<span style="color: #b44343"><mark>交叉闭合</span></mark>',
  ])("无法表示的 HTML 继续保留源码：%s", (source) => {
    const session = createMarkdownSession(source);
    expect(new TextDecoder().decode(session.snapshot(session.doc).bytes)).toBe(source);
    expect(session.doc.firstChild?.firstChild?.type.name).toBe("html_inline");
    const styles: string[] = [];
    session.doc.descendants((node) => {
      styles.push(...node.marks.map((mark) => mark.type.name));
    });
    expect(styles).toEqual([]);
  });

  it("修改样式内文字时保留邻近字节与准确源码位置", () => {
    const source = '\uFEFF前文 _不动_ <span style="color: #B44343;"><u>定位</u></span> 后文\r\n';
    const session = createMarkdownSession(source);
    const position = session.positionAt(source.indexOf("定位"));
    expect(session.doc.textBetween(position, position + 2)).toBe("定位");
    expect(session.sourceOffsetAt(position)).toBe(source.indexOf("定位"));
    const state = EditorState.create({ doc: session.doc });
    const tr = state.tr.insertText("修改", position, position + 2);
    session.track(tr);
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(session.snapshot(tr.doc).bytes),
    ).toBe(source.replace("定位", "修改"));
  });
});
