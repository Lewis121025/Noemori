/** @vitest-environment jsdom */
import { DOMParser, DOMSerializer } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { documentSchema } from "@reader/renderer/engine/markdown/schema";

describe("源码节点的剪贴板保真", () => {
  it.each([
    '[文档](https://example.com/ "说明") 和 [[知识|别名]]\n',
    "---\ntitle: Note\n---\n\nBody\n",
    "Text[^1]\n\n[^1]: Footnote\n\n    Second paragraph.\n",
  ])("复制粘贴后仍按原语法保存", (source) => {
    const doc = parseMarkdown(source);
    const wrapper = document.createElement("div");
    wrapper.append(DOMSerializer.fromSchema(documentSchema).serializeFragment(doc.content));
    const pasted = DOMParser.fromSchema(documentSchema).parse(wrapper);

    expect(pasted.eq(doc)).toBe(true);
    expect(serializeMarkdown(pasted)).toBe(serializeMarkdown(doc));
  });
});
