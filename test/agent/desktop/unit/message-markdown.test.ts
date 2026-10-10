import { expect, it } from "vitest";
import { parseMessageMarkdown } from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/message-markdown";

it("重复标题和标题自带编号共存，生成的锚点保持唯一且顺序稳定", () => {
  const message = parseMessageMarkdown("# Topic\n\n# Topic-1\n\n# Topic\n\n# Topic-1\n\n# Topic");
  expect([...message.headings.values()]).toEqual([
    "topic",
    "topic-1",
    "topic-2",
    "topic-1-1",
    "topic-3",
  ]);
  const repeated = parseMessageMarkdown("# 重复标题\n\n".repeat(2000));
  const anchors = [...repeated.headings.values()];
  expect(new Set(anchors).size).toBe(2000);
  expect(anchors.at(-1)).toBe("重复标题-1999");
});

it("循环脚注只呈现每份定义一次，首次定义和全部返回位置均保留", () => {
  const message = parseMessageMarkdown(
    "正文[^b]\n\n[^a]: 甲[^b]\n[^b]: 乙[^a] [资料][doc]\n[^b]: 重复定义\n\n[doc]: https://example.com/first\n[doc]: https://example.com/second",
  );
  expect(
    message.footnotes.map((note) => ({
      identifier: note.node.identifier,
      number: note.number,
      references: note.references,
    })),
  ).toEqual([
    { identifier: "b", number: 1, references: 2 },
    { identifier: "a", number: 2, references: 1 },
  ]);
  expect([...message.links.values()]).toEqual([
    { kind: "external", url: "https://example.com/first", title: null },
  ]);
  expect([...message.references.values()]).toEqual([
    { number: 1, occurrence: 1 },
    { number: 2, occurrence: 1 },
    { number: 1, occurrence: 2 },
  ]);
});

it("段落容器依据实际预览分类，嵌套图片会提升容器，邮件和锚点不会", () => {
  const message = parseMessageMarkdown(
    "**![图][img]**\n\n[邮件](mailto:report.pdf)\n\n[标题](#diagram.png)\n\n[img]: picture.png",
  );
  const paragraphs = message.tree.children.filter((node) => node.type === "paragraph");
  expect(paragraphs.map((node) => message.richParagraphs.has(node))).toEqual([true, false, false]);
  expect([...message.links.values()]).toEqual([
    { kind: "content", url: "picture.png", title: null },
    { kind: "external", url: "mailto:report.pdf", title: null },
    { kind: "anchor", fragment: "diagram.png" },
  ]);
});
