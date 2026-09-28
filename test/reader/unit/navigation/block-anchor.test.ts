import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { findBlockPmPos, sliceEmbed } from "@reader/renderer/engine/navigation/block-anchor";

describe("块引用", () => {
  it("定位块末尾的标识，单独成段的标识指向前一块", () => {
    const doc = parseMarkdown("第一段 ^alpha\n\n第二段\n\n^beta\n");
    const alpha = findBlockPmPos(doc, "alpha");
    const beta = findBlockPmPos(doc, "beta");
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();
    expect(alpha).not.toBe(beta);
    expect(doc.nodeAt(alpha ?? 0)?.textContent).toContain("第一段");
    expect(doc.nodeAt(beta ?? 0)?.textContent).toContain("第二段");
    expect(findBlockPmPos(doc, "missing")).toBeNull();
    expect(findBlockPmPos(doc, "bad id")).toBeNull();
  });

  it("嵌入按标题切到下一同级标题，块引用只取那一块", () => {
    const doc = parseMarkdown("# 甲\n\n甲的正文\n\n## 小节\n\n细节\n\n# 乙\n\n乙的正文\n\n段落 ^bid\n");
    const section = sliceEmbed(doc, "甲");
    expect(section?.textContent).toContain("甲的正文");
    expect(section?.textContent).toContain("小节");
    expect(section?.textContent).not.toContain("乙的正文");
    const block = sliceEmbed(doc, "^bid");
    expect(block?.textContent).toContain("段落");
    expect(block?.textContent).not.toContain("甲的正文");
    expect(sliceEmbed(doc, "^missing")).toBeNull();
    expect(sliceEmbed(doc, null)?.textContent).toContain("乙的正文");
  });

  it("引用里的标题只切到该引用内部的下一节", () => {
    const doc = parseMarkdown("> # 内\n>\n> 引用正文\n>\n> # 后\n\n# 外\n\n外面\n");
    const section = sliceEmbed(doc, "内");
    expect(section?.textContent).toContain("引用正文");
    expect(section?.textContent).not.toContain("后");
    expect(section?.textContent).not.toContain("外面");
  });
});
