import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/markdown/math.md");

function collectTex(doc: ReturnType<typeof parseMarkdown>, type: string): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) {
      out.push(String(node.attrs["tex"] ?? ""));
    }
  });
  return out;
}

describe("markdown math adapter", () => {
  it("maps inline and block math from the shared fixture", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    expect(collectTex(doc, "math_inline")).toEqual(["E=mc^2", String.raw`\notacommand{`]);
    expect(collectTex(doc, "math_block")).toEqual([String.raw`\int_0^1 x^2 \, dx`]);
  });

  it("does not treat dollars inside code as math", () => {
    const source = readFileSync(fixture, "utf8");
    const doc = parseMarkdown(source);
    const all = [...collectTex(doc, "math_inline"), ...collectTex(doc, "math_block")];
    expect(all.some((tex) => tex.includes("not-math") || tex.includes("also-code"))).toBe(false);

    let codeHasDollar = false;
    doc.descendants((node) => {
      if (node.type.name === "code_block" && (node.textContent.includes("$not-math$") || node.textContent.includes("$also-code$"))) {
        codeHasDollar = true;
      }
      if (node.isText && node.marks.some((mark) => mark.type.name === "code") && node.text?.includes("$also-code$")) {
        codeHasDollar = true;
      }
    });
    expect(codeHasDollar).toBe(true);
  });

  it("roundtrips math delimiters stably", () => {
    const source = "See $a+b$ and\n\n$$\n\\frac{1}{2}\n$$\n";
    const parsed = parseMarkdown(source);
    expect(collectTex(parsed, "math_inline")).toEqual(["a+b"]);
    expect(collectTex(parsed, "math_block")).toEqual(["\\frac{1}{2}"]);
    const first = serializeMarkdown(parsed);
    const second = serializeMarkdown(parseMarkdown(first));
    expect(second).toBe(first);
    expect(first).toContain("$a+b$");
    expect(first).toContain("$$");
    expect(first).toContain("\\frac{1}{2}");
  });

  it("serializes math as dollar delimiters not html", () => {
    const source = readFileSync(fixture, "utf8");
    const out = serializeMarkdown(parseMarkdown(source));
    expect(out).toContain("$E=mc^2$");
    expect(out).toContain("$$");
    expect(out).not.toMatch(/<mjx-|<\/math>|data-math-tex/);
  });

  it("keeps invalid tex on the node so source is not lost", () => {
    const doc = parseMarkdown("Bad $\\foo{$.\n");
    expect(collectTex(doc, "math_inline")).toEqual([String.raw`\foo{`]);
    expect(serializeMarkdown(doc)).toContain("$\\foo{$");
  });
});
