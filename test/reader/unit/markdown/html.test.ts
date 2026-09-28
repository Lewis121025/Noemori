import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/markdown/html.md");

function collectHtml(doc: ReturnType<typeof parseMarkdown>, type: string): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) {
      out.push(String(node.attrs["html"] ?? ""));
    }
  });
  return out;
}

describe("markdown html adapter", () => {
  it("maps inline and block html from the shared fixture", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    expect(collectHtml(doc, "html_inline")).toEqual([
      '<a id="complete_zero"></a>',
      '<img src="x" onerror="alert(1)">',
    ]);
    expect(collectHtml(doc, "html_block")).toEqual(["<div>\nblock-html\n</div>"]);
  });

  it("does not treat html inside code as html nodes", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    const all = [...collectHtml(doc, "html_inline"), ...collectHtml(doc, "html_block")];
    expect(all.some((html) => html.includes("in-fence") || html.includes("in-code"))).toBe(false);

    let codeHasHtml = false;
    doc.descendants((node) => {
      if (node.type.name === "code_block" && node.textContent.includes('<a id="in-fence"></a>')) {
        codeHasHtml = true;
      }
      if (
        node.isText &&
        node.marks.some((mark) => mark.type.name === "code") &&
        node.text?.includes("<span>in-code</span>")
      ) {
        codeHasHtml = true;
      }
    });
    expect(codeHasHtml).toBe(true);
  });

  it("roundtrips html source stably", () => {
    const source = 'See <a id="n"></a> and\n\n<div>\nbox\n</div>\n';
    const parsed = parseMarkdown(source);
    expect(collectHtml(parsed, "html_inline")).toEqual(['<a id="n"></a>']);
    expect(collectHtml(parsed, "html_block")).toEqual(["<div>\nbox\n</div>"]);
    const first = serializeMarkdown(parsed);
    const second = serializeMarkdown(parseMarkdown(first));
    expect(second).toBe(first);
    expect(first).toContain('<a id="n"></a>');
    expect(first).toContain("<div>");
    expect(first).toContain("box");
  });

  it("keeps unsafe html on the node so source is not lost", () => {
    const doc = parseMarkdown('Bad <img src="x" onerror="alert(1)">.\n');
    expect(collectHtml(doc, "html_inline")).toEqual(['<img src="x" onerror="alert(1)">']);
    expect(serializeMarkdown(doc)).toContain('onerror="alert(1)"');
  });

  it("does not serialize html as escaped text", () => {
    const parsed = parseMarkdown('Hi <a id="z"></a>.\n');
    expect(collectHtml(parsed, "html_inline")).toEqual(['<a id="z"></a>']);
    const out = serializeMarkdown(parsed);
    expect(out).toContain('<a id="z"></a>');
    expect(out).not.toContain("&lt;a");
  });
});
