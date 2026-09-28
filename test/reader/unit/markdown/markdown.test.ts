import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { bytesForSave } from "@reader/renderer/engine/document/save";

const linkFixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../links/fixtures");

describe("markdown adapter", () => {
  it("roundtrips headings lists emphasis and links stably", () => {
    const source = `# Title

A **bold** and *em* and \`code\`.

- one
- two

[go](./Other.md)
`;
    const doc = parseMarkdown(source);
    const first = serializeMarkdown(doc);
    const second = serializeMarkdown(parseMarkdown(first));
    expect(second).toBe(first);
    expect(first).toContain("# Title");
    expect(first).toContain("**bold**");
    expect(first).toContain("[go](./Other.md)");
  });

  it("parses consecutive notes without leaking wiki matches", () => {
    const first = serializeMarkdown(parseMarkdown("See [[Alpha]]\n"));
    const second = serializeMarkdown(parseMarkdown("See [[Beta]]\n"));
    expect(first).toContain("[[Alpha]]");
    expect(first).not.toContain("[[Beta]]");
    expect(second).toContain("[[Beta]]");
    expect(second).not.toContain("[[Alpha]]");
  });

  it("maps wiki links with optional alias", () => {
    const doc = parseMarkdown("See [[Other]] and [[Other|别名]].\n");
    const out = serializeMarkdown(doc);
    expect(out).toContain("[[Other]]");
    expect(out).toContain("[[Other|别名]]");
  });

  it("serializes fenced code blocks", () => {
    const source = "```ts\nconst x = 1;\n```\n";
    const out = serializeMarkdown(parseMarkdown(source));
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1;");
  });

  it("identity write does not call serialize when not dirty", () => {
    const original = new TextEncoder().encode("# Title\n");
    let called = false;
    const out = bytesForSave(false, original, () => {
      called = true;
      return "changed\n";
    });
    expect(called).toBe(false);
    expect(out).toBe(original);
  });

  it("maps shared link fixtures without turning fenced wiki into links", () => {
    const source = readFileSync(join(linkFixtures, "source.md"), "utf8");
    const sourceOut = serializeMarkdown(parseMarkdown(source));
    expect(sourceOut).toContain("[[Other]]");
    expect(sourceOut).toContain("](./Other.md)");

    const code = readFileSync(join(linkFixtures, "code_and_wiki.md"), "utf8");
    const doc = parseMarkdown(code);
    let wikiCount = 0;
    doc.descendants((node) => {
      if (node.type.name === "wiki_link") {
        wikiCount += 1;
      }
    });
    expect(wikiCount).toBe(1);
    const codeOut = serializeMarkdown(doc);
    expect(codeOut).toContain("[[FakeFence]]");
    expect(codeOut).toContain("[[FakeInline]]");
    expect(codeOut).toContain("[[Other]]");
  });

  it("parses a list item that starts with a nested list", () => {
    const source = `- 
  - child
`;
    expect(() => parseMarkdown(source)).not.toThrow();
    const doc = parseMarkdown(source);
    expect(serializeMarkdown(doc)).toContain("child");
  });

  it("parses an empty blockquote without throwing", () => {
    const source = `>
`;
    expect(() => parseMarkdown(source)).not.toThrow();
    expect(serializeMarkdown(parseMarkdown(source))).toContain(">");
  });
});
