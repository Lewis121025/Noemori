import type { Nodes, Paragraph, Root } from "mdast";
import { markdownProcessor } from "./markdown-processor";
import { restoreTextStyles } from "./text-style";

type Line = { start: number; end: number; text: string };

/**
 * 在标准语法树的块间空白中补回可编辑空段；正文、代码与行内换行仍由解析器决定。
 * 一条空行用于分隔普通块，其余空行各对应一个空段；空文件保留一个落笔位置。
 * @param source 不含 BOM 的原始 Markdown，位置保持原始 UTF-16 偏移及换行。
 * @returns 带完整源码位置的语法树，供文档解析和位置映射共同使用。
 * @throws 解析器无法承载源码时沿用其异常，不降级为空文档。
 */
export function parseMarkdownLayout(source: string): Root {
  const tree = markdownProcessor.parse(source);
  const lines: Line[] = [];
  let start = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ start, end: match.index, text: source.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  lines.push({ start, end: source.length, text: source.slice(start) });
  restoreLayout(tree, lines, lines.length + 1);
  restoreTextStyles(tree);
  return tree;
}

function restoreLayout(node: Nodes, lines: Line[], limit: number): void {
  if (!("children" in node) || node.position === undefined) return;
  const position = node.position;
  restoreEmptyTask(node, lines);
  const original = [...node.children];
  original.forEach((child, index) => {
    restoreLayout(child, lines, original[index + 1]?.position?.start.line ?? limit);
    if (
      child.position !== undefined &&
      (child.position.end.offset ?? 0) > (position.end.offset ?? 0)
    )
      position.end = child.position.end;
  });
  extendIndentedContainer(node, lines, limit);
  // 列表自身没有空段；解析器计入范围的尾随空行应交给外层引用或文档恢复。
  if (node.type === "list") {
    const end = node.children.at(-1)?.position?.end;
    if (end !== undefined) position.end = end;
    return;
  }
  if (
    node.type !== "root" &&
    node.type !== "blockquote" &&
    node.type !== "listItem" &&
    node.type !== "footnoteDefinition"
  )
    return;
  const first = node.children[0];
  const last = node.children.at(-1);
  const leadingEnd = first?.position?.start.line ?? node.position.end.line + 1;
  const leading: Paragraph[] = [];
  for (let line = node.position.start.line; line < leadingEnd; line++) {
    const blank = blankParagraph(lines, line);
    if (blank !== null) leading.push(blank);
  }
  let inserted = 0;
  for (let index = 1; index < original.length; index++) {
    const left = original[index - 1]?.position;
    const right = original[index]?.position;
    if (left === undefined || right === undefined) continue;
    for (let line = left.end.line + 2; line < right.start.line; line++) {
      const blank = blankParagraph(lines, line);
      if (blank !== null) node.children.splice(index + inserted++, 0, blank);
    }
  }
  node.children.unshift(...leading);
  if (last?.position !== undefined) {
    for (let line = last.position.end.line + 2; line <= node.position.end.line; line++) {
      const blank = blankParagraph(lines, line);
      if (blank !== null) node.children.push(blank);
    }
  }
}

function restoreEmptyTask(node: Nodes, lines: Line[]): void {
  if (node.type !== "listItem" || node.checked != null) return;
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph" || paragraph.children.length !== 1) return;
  const text = paragraph.children[0];
  const range = paragraph.position;
  if (text?.type !== "text" || range === undefined || range.start.line !== range.end.line) return;
  const raw = lines[range.start.line - 1]?.text.slice(range.start.column - 1, range.end.column - 1);
  // GFM 不识别没有正文的任务；只有未经转义的独立标记才是任务，字面文本不能被改义。
  if (raw?.trimEnd() !== text.value || !/^\[[ xX]\]$/.test(text.value)) return;
  node.checked = text.value !== "[ ]";
  paragraph.children = [];
  paragraph.position = { start: range.end, end: range.end };
}

function blankParagraph(lines: Line[], number: number): Paragraph | null {
  const line = lines[number - 1];
  if (line === undefined || !/^[\t >]*(?:(?:[-+*]|\d+[.)]|\[\^[^\]]+\]:)[ \t]*)?$/.test(line.text))
    return null;
  const point = { line: number, column: line.text.length + 1, offset: line.end };
  return { type: "paragraph", children: [], position: { start: point, end: point } };
}

function extendIndentedContainer(node: Nodes, lines: Line[], limit: number): void {
  if (
    (node.type !== "listItem" && node.type !== "footnoteDefinition") ||
    node.position === undefined
  )
    return;
  const first = lines[node.position.start.line - 1];
  if (first === undefined) return;
  const at = node.position.start.column - 1;
  const marker = /^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(first.text.slice(at));
  const width = node.type === "footnoteDefinition" ? 4 : Math.max(2, marker?.[0].length ?? 2);
  const prefix = first.text.slice(0, at).replace(/[^\t >]/g, " ") + " ".repeat(width);
  for (let number = node.position.end.line + 1; number < limit; number++) {
    const line = lines[number - 1];
    if (
      line === undefined ||
      !line.text.startsWith(prefix) ||
      !/^[\t ]*$/.test(line.text.slice(prefix.length))
    )
      break;
    node.position.end = { line: number, column: line.text.length + 1, offset: line.end };
  }
}
