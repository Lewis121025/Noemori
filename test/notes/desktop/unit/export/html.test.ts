/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { parseExportHtml, parseInlineExportHtml } from "@reader/renderer/export/html";
import { portableMarkdown } from "@reader/main/export/documents";
import { DOMParser as PmParser, DOMSerializer } from "prosemirror-model";
import { documentSchema } from "@reader/shared/markdown/schema";

describe("导出行内 HTML 的完整上下文", () => {
  it("受控颜色和下划线在标准 HTML 导出及剪贴板往返中保留", () => {
    const source = '<u><span style="color: #b44343"><mark style="background-color: #cde1f5">**[组合](note.md)** `代码`</mark></span></u>';
    const doc = parseMarkdown(source);
    const html = document.createElement("div");
    html.append(DOMSerializer.fromSchema(documentSchema).serializeFragment(doc.content));
    expect(PmParser.fromSchema(documentSchema).parse(html).eq(doc)).toBe(true);
    // 导出解析只接受单一受控声明；Clipboard 的主题变量由 schema DOM 解析，不经导出清理。
    expect(parseExportHtml('<u><span style="color: #b44343"><mark style="background-color: #cde1f5"><strong>文字</strong></mark></span></u>').firstChild?.firstChild?.marks.map((mark) => mark.type.name))
      .toEqual(["strong", "underline", "highlight", "text_color"]);
    const output = portableMarkdown({ path: "a.md", output: "a.md", doc, anchors: [], locations: new Map(), formulaLocations: new Map() });
    expect(output).toContain('style="color: #b44343"');
    expect(output).toContain('style="background-color: #cde1f5"');
    expect(parseMarkdown(output).eq(doc)).toBe(true);
  });

  it("无表头与多表头表格迁移为标准 HTML，不能改变数据行的身份", () => {
    for (const headers of ["", "<tr><th>第一层</th></tr><tr><th>第二层</th></tr>"]) {
      const doc = parseExportHtml(
        `<table>${headers}<tr><td><strong>第一条数据</strong></td></tr><tr><td>第二条数据</td></tr></table>`,
      );
      const markdown = portableMarkdown({
        path: "a.md",
        output: "a.md",
        doc,
        anchors: [],
        locations: new Map(),
        formulaLocations: new Map(),
      });
      const result = new DOMParser().parseFromString(markdown, "text/html");
      expect(result.querySelectorAll("th")).toHaveLength(headers ? 2 : 0);
      expect(Array.from(result.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual([
        "第一条数据",
        "第二条数据",
      ]);
      expect(result.querySelector("td strong")?.textContent).toBe("第一条数据");
    }
  });
  it("成对标签包裹 Markdown 文字、公式及原有格式时保留组合语义", () => {
    const source = parseMarkdown(
      "前 <strong>HTML加粗 $x^2$ **已有粗体**</strong> <em>HTML斜体</em> 后",
    );
    const result = parseInlineExportHtml(source.firstChild!);
    const texts: { text: string; marks: string[] }[] = [];
    result.descendants((node) => {
      if (node.isText || node.type.name === "math_inline")
        texts.push({
          text: node.text ?? String(node.attrs["tex"]),
          marks: node.marks.map((mark) => mark.type.name),
        });
    });
    expect(
      texts.some((item) => item.text.includes("HTML加粗") && item.marks.includes("strong")),
    ).toBe(true);
    expect(texts.some((item) => item.text === "x^2" && item.marks.includes("strong"))).toBe(true);
    expect(texts.some((item) => item.text === "HTML斜体" && item.marks.includes("em"))).toBe(true);
    expect(result.textContent).toContain("后");
  });
  it.for([
    '<input value="不能悄悄丢掉的内容">',
    '<svg><text x="1" y="1">矢量正文</text></svg>',
    '<iframe src="https://example.test/content"></iframe>',
    '<span style="display:none">具有布局语义的内容</span>',
    '<table><tr><td colspan="2">跨列内容</td></tr></table>',
    '<img src="first.png" srcset="second.png 2x">',
  ])("无法可靠转换的 HTML 不得成为空白或错误布局的成功产物：%s", (source) => {
    expect(() => parseExportHtml(source)).toThrow();
  });
});
