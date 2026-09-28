import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { documentSchema } from "@reader/renderer/engine/markdown/schema";

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkGfm)
  .use(remarkMath);

/** 去除位置及排版属性，比较独立解析器得到的内容语义。 */
function semantics(source: string): unknown {
  return JSON.parse(
    JSON.stringify(parser.parse(source), (key, value: unknown) =>
      key === "position" || key === "data" || key === "spread" ? undefined : value,
    ),
  );
}

describe("编辑后保存的 Markdown 保真", () => {
  it.each([
    "---\ntitle: A note\ntags:\n  - notes\n---",
    '+++\ntitle = "A note"\ntags = ["notes"]\n+++',
  ])("修改正文不破坏头部元数据 %s", (metadata) => {
    const doc = parseMarkdown(`${metadata}\n\nBody\n`);
    const edited = doc.copy(
      doc.content.replaceChild(
        1,
        documentSchema.node("paragraph", null, documentSchema.text("Edited body")),
      ),
    );
    const saved = serializeMarkdown(edited);
    expect(saved).toContain(metadata);
    expect(semantics(saved)).toEqual(semantics(`${metadata}\n\nEdited body\n`));
  });

  it.each([
    ["引用链接", '[guide][ref]\n\n[ref]: ./Other.md "A title"\n'],
    ["引用图片", '![diagram][img]\n\n[img]: ./diagram.png "Diagram"\n'],
    ["脚注", "Text[^1]\n\n[^1]: Important footnote\n\n    Second paragraph.\n"],
    ["引用内的脚注", "> Text[^1]\n>\n> [^1]: First\n>\n>     Second\n"],
    ["嵌套代码围栏", "````md extra-info\n```js\nconst x = 1\n```\n````\n"],
    ["含反引号的行内代码", "Use ``a ` b`` and `` `edge` ``.\n"],
    ["字面量公式分隔符", "Literal \\$x\\$ text\n"],
    ["字面量 HTML 与删除线", "\\<span> and \\~\\~plain\\~\\~\n"],
    ["多位编号与嵌套列表", "10. parent\n    - child\n\n    another paragraph\n11. next\n"],
    ["嵌套行内格式", "**bold *and italic* still bold**\n"],
    ["复杂链接与图片", '[a **bold** link](<a b(c).md> "say \\"hi\\"") and ![a\\]b](<a b.png>)\n'],
    ["表格中的代码与分隔符", "| A | B |\n| --- | --- |\n| `a\\|b` | x\\|y |\n"],
  ])("修改标题不破坏%s", (_name, body) => {
    const source = `# Title\n\n${body}`;
    const doc = parseMarkdown(source);
    const heading = doc.firstChild!;
    const editedHeading = heading.type.create(heading.attrs, [
      ...heading.content.content,
      documentSchema.text(" updated"),
    ]);
    const edited = doc.copy(doc.content.replaceChild(0, editedHeading));
    const saved = serializeMarkdown(edited);

    expect(semantics(saved)).toEqual(semantics(`# Title updated\n\n${body}`));
    expect(serializeMarkdown(parseMarkdown(saved))).toBe(saved);
  });

  it("转义的双括号保持普通文本", () => {
    const source = "Literal \\[\\[Other\\]\\] and [[Real]]\n";
    const doc = parseMarkdown(source);
    const targets: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === "wiki_link") targets.push(String(node.attrs["target"]));
    });
    expect(targets).toEqual(["Real"]);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });

  it("保留 wiki 链接与公式上的格式", () => {
    const source = "**[[Other|别名]]** and *$x$*\n";
    const doc = parseMarkdown(source);
    const saved = serializeMarkdown(doc);
    expect(saved).toContain("**[[Other|别名]]**");
    expect(saved).toContain("*$x$*");
    expect(parseMarkdown(saved).eq(doc)).toBe(true);
  });

  it.each([
    "[[a&amp;copy;|&#93;]]\n",
    String.raw`[[a\\*b|x&amp;copy;]]`,
    "| Note |\n| --- |\n| [[Other\\|别名]] |\n",
  ])("wiki 目标与别名经过保存不被二次解码", (source) => {
    const doc = parseMarkdown(source);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });
});
