/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { DOMParser, DOMSerializer } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { documentSchema } from "@reader/renderer/engine/markdown/schema";

describe("PDF 附件引用保真", () => {
  it.each([
    "![[paper.pdf]]",
    "**![[paper.PDF|论文]]**",
    '![论文](<papers/my paper.pdf> "说明")',
    '![论文][paper]\n\n[paper]: papers/article.pdf "说明"',
    "| 附件 |\n| --- |\n| ![[paper.pdf\\|论文]] |",
  ])("预览、保存与剪贴板保留附件语法：%s", (source) => {
    const doc = parseMarkdown(source);
    const types: string[] = [];
    doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).toContain("pdf");
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
    const host = document.createElement("div");
    host.append(DOMSerializer.fromSchema(documentSchema).serializeFragment(doc.content));
    expect(DOMParser.fromSchema(documentSchema).parse(host).eq(doc)).toBe(true);
  });

  it("普通 PDF 链接保持链接，不被强制嵌入", () => {
    const doc = parseMarkdown("[[paper.pdf]] and [论文](paper.pdf)");
    const types: string[] = [];
    doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).not.toContain("pdf");
    expect(types).toContain("wiki_link");
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });
});
