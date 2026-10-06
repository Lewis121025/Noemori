import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { serializeMarkdown } from "@reader/shared/markdown/serialize";

function embeds(source: string) {
  const doc = parseMarkdown(source);
  const out: { target: string; alias: string | null; anchor: string | null }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "note_embed") {
      out.push({
        target: String(node.attrs["target"] ?? ""),
        alias: (node.attrs["alias"] as string | null) ?? null,
        anchor: (node.attrs["anchor"] as string | null) ?? null,
      });
    }
  });
  return out;
}

describe("笔记嵌入", () => {
  it("独立的笔记嵌入往返为 wiki 嵌入，图片嵌入仍然是图片", () => {
    expect(embeds("![[笔记]]\n")).toEqual([{ target: "笔记", alias: null, anchor: null }]);
    expect(embeds("![[笔记#小节|别名]]\n")).toEqual([
      { target: "笔记", alias: "别名", anchor: "小节" },
    ]);
    expect(embeds("![[笔记#^bid]]\n")).toEqual([{ target: "笔记", alias: null, anchor: "^bid" }]);
    const saved = serializeMarkdown(parseMarkdown("![[笔记#小节|别名]]\n"));
    expect(saved).toContain("![[笔记#小节|别名]]");
    expect(embeds("See ![[笔记]].\n")).toEqual([]);
    expect(embeds("![[shot.jpg]]\n")).toEqual([]);
  });

  it("引用块与列表项内独立成段的嵌入同样提升，句中嵌入保持链接", () => {
    expect(embeds("> ![[引用内]]\n")).toEqual([{ target: "引用内", alias: null, anchor: null }]);
    // 列表项整体是嵌入：首子节点即嵌入块。
    expect(embeds("- ![[列表项]]\n")).toEqual([{ target: "列表项", alias: null, anchor: null }]);
    // 列表项内文字之后的独立嵌入段落也提升。
    expect(embeds("- 条目\n\n  ![[项内]]\n")).toEqual([
      { target: "项内", alias: null, anchor: null },
    ]);
    expect(embeds("句中 ![[笔记]] 不提升。\n")).toEqual([]);
  });

  it("列表与引用内的嵌入往返保真", () => {
    for (const source of ["- ![[列表项]]\n", "> ![[引用内]]\n", "- 条目\n\n  ![[项内]]\n"]) {
      expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
    }
  });

  it("解析层始终提升嵌套嵌入，深度与环由视图层控制", () => {
    // 嵌入内容里的嵌入照常成为节点；递归渲染的截止在 content-view。
    expect(embeds("![[外层]]\n")).toHaveLength(1);
  });
});
