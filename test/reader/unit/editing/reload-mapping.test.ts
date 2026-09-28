import { expect, it } from "vitest";
import type { Node as PmNode } from "prosemirror-model";
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorSelection, Text } from "@codemirror/state";
import { parseMarkdown } from "@reader/renderer/engine/markdown/parse";
import {
  markdownReloadMapping,
  textReloadChanges,
} from "@reader/renderer/engine/editing/reload-mapping";

function locate(doc: PmNode, text: string): number {
  let found: number | null = null;
  doc.descendants((node, position) => {
    const offset = node.text?.indexOf(text) ?? -1;
    if (offset >= 0 && found === null) found = position + offset;
  });
  if (found === null) throw new Error(`未找到 ${text}`);
  return found;
}

it("长文首尾被外部改写时，中间的反向选区仍覆盖原文", () => {
  const selected = "当前想法 👩‍💻 é 继续写作。";
  const paragraphs = Array.from({ length: 100 }, (_, index) =>
    index === 50 ? selected : `第 ${index + 1} 段，有自己的内容与位置。`,
  );
  const original = "# 阅读上下文\n\n" + paragraphs.join("\n\n") + "\n\n$$\nx+y+z\n$$\n";
  const external = original
    .replace("# 阅读上下文", "# 阅读上下文\n\n外部新增的第一段。")
    .replace("第 100 段", "外部更新的末段");
  const before = parseMarkdown(original);
  const after = parseMarkdown(external);
  const text = "继续写作。";
  const from = locate(before, text);
  const selection = TextSelection.create(before, from + text.length, from);
  const mapped = selection.map(after, markdownReloadMapping(before, after));
  expect(after.textBetween(mapped.from, mapped.to)).toBe(text);
  expect(mapped.head < mapped.anchor).toBe(true);
});

it("分散外部修改之间的中文、emoji 和组合字符反向选区仍指向原文", () => {
  const before = parseMarkdown("开头\n\n中文 👩‍💻 é 继续\n\n结尾\n");
  const after = parseMarkdown("新的开头\n\n额外段落\n\n中文 👩‍💻 é 继续\n\n新的结尾\n");
  const text = "👩‍💻 é";
  const from = locate(before, text);
  const selection = TextSelection.create(before, from + text.length, from);
  const mapped = selection.map(after, markdownReloadMapping(before, after));
  expect(mapped.anchor).toBe(locate(after, text) + text.length);
  expect(mapped.head).toBe(locate(after, text));
});

it("列表、表格和格式变化保留文字位置，不把节点边界当成正文", () => {
  const before = parseMarkdown("- 第一项\n- 第二项\n\n| A | B |\n| - | - |\n| 目标 | 保留 |\n");
  const after = parseMarkdown(
    "前文\n\n- 新增项\n- 第一项\n- 第二项\n\n| A | B |\n| - | - |\n| **目标** | 保留 |\n\n后文\n",
  );
  const mapping = markdownReloadMapping(before, after);
  for (const text of ["第二项", "目标", "保留"])
    expect(mapping.map(locate(before, text))).toBe(locate(after, text));
});

it("源码节点选择和全选在重载后仍有效，删除当前位置时退到可编辑边界", () => {
  const before = parseMarkdown("前文\n\n$$\nx+y\n$$\n\n删除这里\n");
  const after = parseMarkdown("新增\n\n前文\n\n$$\nx-y\n$$\n\n保留\n");
  const mapping = markdownReloadMapping(before, after);
  const selection = NodeSelection.create(before, before.child(0).nodeSize);
  const mapped = selection.map(after, mapping);
  expect(mapped).toBeInstanceOf(NodeSelection);
  expect(mapped.$from.nodeAfter?.attrs["tex"]).toBe("x-y");
  expect(new AllSelection(before).map(after, mapping).to).toBe(after.content.size);
  const deleted = TextSelection.create(before, locate(before, "删除这里") + 2).map(after, mapping);
  expect(deleted.$head.parent.inlineContent).toBe(true);
  expect(deleted.head).toBeLessThanOrEqual(after.content.size);
});

it("普通文本多选区按外部差异映射，不切开 emoji 代理对", () => {
  const before = "一\n目标 👩‍💻 é\n三";
  const after = "一改\n插入\n目标 👩‍💻 é\n三改";
  const from = before.indexOf("👩");
  const selection = EditorSelection.create([
    EditorSelection.range(from + 5, from),
    EditorSelection.cursor(before.length),
  ]);
  const changes = textReloadChanges(before, after);
  const mapped = selection.map(changes);
  expect(mapped.ranges[0]?.anchor).toBe(after.indexOf("👩") + 5);
  expect(mapped.ranges[0]?.head).toBe(after.indexOf("👩"));
  expect(changes.apply(Text.of(before.split("\n"))).toString()).toBe(after);
});
