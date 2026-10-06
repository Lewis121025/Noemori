import { expect, it } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { serializeMarkdown } from "@reader/shared/markdown/serialize";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";

const source = '```webpage\n{"url":"https://example.com/","height":480}\n```\n';

it("网页块成为独立节点，保存与重新打开保留地址和高度", () => {
  const doc = parseMarkdown(source);
  expect(doc.firstChild?.type.name).toBe("webpage");
  expect(doc.firstChild?.attrs).toMatchObject({ url: "https://example.com/", height: 480 });
  expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  const session = createMarkdownSession(source);
  expect(new TextDecoder().decode(session.snapshot(session.doc).bytes)).toBe(source);
});

it("非法网页配置保留为代码，不能加载本地文件或丢弃用户源码", () => {
  for (const value of [
    '{"url":"file:///etc/passwd","height":480}',
    '{"url":"javascript:alert(1)","height":480}',
    '{"url":"https://example.com/","height":-1}',
    '{"url":"https://example.com/","height":99999}',
    '{"url":"https://user:secret@example.com/","height":480}',
    "invalid JSON",
  ]) {
    const doc = parseMarkdown(`\`\`\`webpage\n${value}\n\`\`\`\n`);
    expect(doc.firstChild?.type.name).toBe("code_block");
    expect(doc.firstChild?.textContent).toBe(value);
  }
});

it("列表和引用内的网页块可往返，编辑相邻文字不重写网页配置", () => {
  const nested = `> ${source.trimEnd().replaceAll("\n", "\n> ")}\n`;
  expect(parseMarkdown(serializeMarkdown(parseMarkdown(nested))).eq(parseMarkdown(nested))).toBe(
    true,
  );
  const session = createMarkdownSession(`前文\r\n\r\n${source.replaceAll("\n", "\r\n")}\r\n后文`);
  const tr = session.doc.type.schema.node("doc", null, [
    session.doc.type.schema.node("paragraph", null, session.doc.type.schema.text("新前文")),
    ...session.doc.content.content.slice(1),
  ]);
  const saved = new TextDecoder().decode(session.snapshot(tr).bytes);
  expect(saved).toContain(source.replaceAll("\n", "\r\n"));
  expect(saved).toContain("新前文");
});
