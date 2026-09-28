import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/markdown/gfm.md");

function collect(
  doc: ReturnType<typeof parseMarkdown>,
  type: string,
  attr: string,
): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) {
      out.push(String(node.attrs[attr] ?? ""));
    }
  });
  return out;
}

function collectImages(doc: ReturnType<typeof parseMarkdown>) {
  const out: { src: string; alt: string; title: unknown; kind: string }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image") {
      out.push({
        src: String(node.attrs["src"] ?? ""),
        alt: String(node.attrs["alt"] ?? ""),
        title: node.attrs["title"] ?? null,
        kind: String(node.attrs["kind"] ?? ""),
      });
    }
  });
  return out;
}

describe("gfm adapter", () => {
  it("maps markdown and wiki images from the shared fixture", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    expect(collectImages(doc)).toEqual([
      { src: "./pic.png", alt: "logo", title: "t", kind: "md" },
      { src: "shot.jpg", alt: "截图", title: null, kind: "wiki" },
    ]);
    expect(collect(doc, "wiki_link", "target")).toEqual(["shot.jpg", "Other"]);
  });

  it("does not treat images inside code as image nodes", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    const srcs = collectImages(doc).map((image) => image.src);
    expect(srcs.some((src) => src.includes("no.png"))).toBe(false);

    let codeHasImage = false;
    doc.descendants((node) => {
      if (node.type.name === "code_block" && node.textContent.includes("![not-img](./no.png)")) {
        codeHasImage = true;
      }
      if (
        node.isText &&
        node.marks.some((mark) => mark.type.name === "code") &&
        node.text?.includes("![also](./no.png)")
      ) {
        codeHasImage = true;
      }
    });
    expect(codeHasImage).toBe(true);
  });

  it("roundtrips markdown image wiki image strike task list and table", () => {
    const source = `A ![logo](./pic.png "t") and ![[shot.jpg|截图]].

~~gone~~

- [ ] todo
- [x] done

| h1 | h2 |
| --- | ---: |
| a | b |
`;
    const parsed = parseMarkdown(source);
    expect(collectImages(parsed)).toEqual([
      { src: "./pic.png", alt: "logo", title: "t", kind: "md" },
      { src: "shot.jpg", alt: "截图", title: null, kind: "wiki" },
    ]);
    const first = serializeMarkdown(parsed);
    const second = serializeMarkdown(parseMarkdown(first));
    expect(second).toBe(first);
    expect(first).toContain("![logo](./pic.png \"t\")");
    expect(first).toContain("![[shot.jpg|截图]]");
    expect(first).toContain("~~gone~~");
    expect(first).toContain("- [ ] todo");
    expect(first).toContain("- [x] done");
    expect(first).toContain("| h1 | h2 |");
    expect(first).toContain("| a | b |");
  });

  it("does not convert wiki image embed into markdown image syntax", () => {
    const doc = parseMarkdown("See ![[shot.jpg]].\n");
    expect(collectImages(doc)).toEqual([
      { src: "shot.jpg", alt: "", title: null, kind: "wiki" },
    ]);
    const out = serializeMarkdown(doc);
    expect(out).toContain("![[shot.jpg]]");
    expect(out).not.toContain("![](");
  });

  it("keeps html img as html so source is not rewritten", () => {
    const doc = parseMarkdown('Pic <img src="./x.png" alt="x">.\n');
    expect(collect(doc, "html_inline", "html")).toEqual(['<img src="./x.png" alt="x">']);
    expect(collectImages(doc)).toEqual([]);
    expect(serializeMarkdown(doc)).toContain('<img src="./x.png" alt="x">');
  });
});
