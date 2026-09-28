import { describe, expect, it } from "vitest";
import { collectOutline, outlineEquals, buildOutlineTree } from "@reader/renderer/engine/navigation/outline";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";

describe("heading outline", () => {
  it("collects headings in document order with levels and node positions", () => {
    const doc = parseMarkdown(`# Alpha

intro

## Beta

### Gamma

# Delta
`);
    const outline = collectOutline(doc);
    expect(outline.map((item) => ({ level: item.level, text: item.text }))).toEqual([
      { level: 1, text: "Alpha" },
      { level: 2, text: "Beta" },
      { level: 3, text: "Gamma" },
      { level: 1, text: "Delta" },
    ]);
    for (const item of outline) {
      expect(doc.nodeAt(item.pos)?.type.name).toBe("heading");
      expect(Number(doc.nodeAt(item.pos)?.attrs["level"] ?? 0)).toBe(item.level);
    }
  });

  it("skips empty headings and headings inside fenced code", () => {
    const doc = parseMarkdown(`# Visible

#

##   

\`\`\`
# not-a-heading
\`\`\`
`);
    expect(collectOutline(doc).map((item) => item.text)).toEqual(["Visible"]);
  });

  it("uses wiki alias or target as heading text", () => {
    const doc = parseMarkdown("## See [[Other|别名]]\n");
    expect(collectOutline(doc)).toEqual([
      expect.objectContaining({ level: 2, text: "See 别名" }),
    ]);
    expect(doc.nodeAt(collectOutline(doc)[0]?.pos ?? -1)?.type.name).toBe("heading");
  });

  it("treats identical outlines as equal", () => {
    const doc = parseMarkdown("# A\n\n## B\n");
    const once = collectOutline(doc);
    expect(outlineEquals(once, collectOutline(doc))).toBe(true);
    expect(outlineEquals(once, collectOutline(parseMarkdown("# A\n\n## C\n")))).toBe(false);
  });

  it("nests headings into a tree by level", () => {
    const items = collectOutline(
      parseMarkdown(`# A

## B

### C

# D

## E
`),
    );
    const tree = buildOutlineTree(items);
    expect(tree.map((node) => node.item.text)).toEqual(["A", "D"]);
    expect(tree[0]?.children.map((node) => node.item.text)).toEqual(["B"]);
    expect(tree[0]?.children[0]?.children.map((node) => node.item.text)).toEqual(["C"]);
    expect(tree[1]?.children.map((node) => node.item.text)).toEqual(["E"]);
    expect(tree[0]?.key).toBe("0");
    expect(tree[0]?.children[0]?.key).toBe("0.0");
    expect(tree[0]?.children[0]?.children[0]?.key).toBe("0.0.0");
    expect(tree[1]?.key).toBe("1");
  });
});
