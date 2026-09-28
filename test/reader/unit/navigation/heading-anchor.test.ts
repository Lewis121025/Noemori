import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import {
  findHeadingPmPos,
  normalizeHeadingText,
} from "@reader/renderer/engine/navigation/heading-anchor";

describe("normalizeHeadingText", () => {
  it("折叠连续空白、去首尾并小写", () => {
    expect(normalizeHeadingText("  Deep   Section ")).toBe("deep section");
    expect(normalizeHeadingText("小节")).toBe("小节");
  });
});

describe("findHeadingPmPos", () => {
  it("大小写不敏感匹配，同名标题取文档顺序的第一个", () => {
    const doc = parseMarkdown("# Intro\n\n## Deep Section\n\ntext\n\n## deep section\n");
    const pos = findHeadingPmPos(doc, "DEEP  SECTION");
    expect(pos).not.toBeNull();
    const node = doc.nodeAt(pos ?? -1);
    expect(node?.type.name).toBe("heading");
    expect(node?.textContent).toBe("Deep Section");
  });

  it("标题含 wiki 链接时按渲染文本匹配，别名优先", () => {
    const doc = parseMarkdown("## See [[Topic|话题]] details\n");
    expect(findHeadingPmPos(doc, "See 话题 details")).not.toBeNull();
    expect(findHeadingPmPos(doc, "See Topic details")).toBeNull();
  });

  it("正文段落里的同词不参与匹配", () => {
    const doc = parseMarkdown("paragraph Deep Section\n");
    expect(findHeadingPmPos(doc, "Deep Section")).toBeNull();
  });

  it("空锚点与空文档不定位", () => {
    expect(findHeadingPmPos(parseMarkdown("# A\n"), "   ")).toBeNull();
    expect(findHeadingPmPos(parseMarkdown(""), "A")).toBeNull();
  });
});
