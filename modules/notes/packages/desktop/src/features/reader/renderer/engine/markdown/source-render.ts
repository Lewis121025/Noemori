import { type Fragment, type Node as PmNode } from "prosemirror-model";
import { serializeMarkdown } from "./serialize";
import { applySourceEdits, type SourceNode } from "./source-map";
import { sourceLinePrefix, sourceTextOffsets } from "./source-text";
import { renderTableSource } from "./source-table";

/**
 * 由只读源码映射生成局部替换，不修改编辑会话或磁盘。
 * @param source 打开时的完整源码。
 * @param tree 与初始文档对应的源码范围。
 * @param current 当前不可变文档。
 * @returns 保留原始 BOM、换行和未改变片段的文本。
 * @throws 范围越界或无法序列化局部语法时失败。
 */
export function renderSource(source: string, tree: SourceNode, current: PmNode): string {
  return source.slice(0, tree.start) + new SourceRenderer(source).render(tree, current);
}

/** 局部渲染只持有原文；所有修改结果通过返回值传出。 */
class SourceRenderer {
  private readonly bom: number;
  private readonly newline: string;

  constructor(private readonly source: string) {
    this.bom = source.startsWith("\uFEFF") ? 1 : 0;
    this.newline = source.includes("\r\n") ? "\r\n" : "\n";
  }

  // 换行转换一律用 (?<!\r)\n：源码保留块（frontmatter 等）的文本内部自带
  // CRLF，盲替换会产出 \r\r\n，保存的往返校验随即失败。

  render(previous: SourceNode, current: PmNode): string {
    if (previous.node.eq(current)) return this.source.slice(previous.start, previous.end);
    if (previous.implicit) {
      const prefix = sourceLinePrefix(this.source, previous.start).replace(/[^\s>]/g, " ");
      return this.replacement(current, previous.start) + this.newline + prefix;
    }
    if (current.type.name === "table" && previous.node.sameMarkup(current))
      return renderTableSource(this.source, previous, current, (before, after) =>
        this.render(before, after),
      );
    const codeEdit = this.editCode(previous, current);
    if (codeEdit !== null) return codeEdit;
    const inlineEdits = this.editInlineChildren(previous, current);
    if (inlineEdits !== null) return inlineEdits;
    const textEdit = this.editText(previous, current);
    if (textEdit !== null) return textEdit;
    const phraseEdit = this.editPhrase(previous, current);
    if (phraseEdit !== null) return phraseEdit;
    if (
      previous.node.sameMarkup(current) &&
      previous.children.length === current.childCount &&
      previous.children.length > 0
    ) {
      const rendered = applySourceEdits(
        this.source.slice(previous.start, previous.end),
        previous.children.map((child, index) => ({
          start: child.start - previous.start,
          end: child.end - previous.start,
          text: this.render(
            child.node.eq(current.child(index))
              ? child
              : (previous.children.find((item) => item.node.eq(current.child(index))) ?? child),
            current.child(index),
          ),
        })),
      );
      return this.listStart(current, rendered);
    }
    if (
      previous.node.sameMarkup(current) &&
      ["bullet_list", "ordered_list"].includes(current.type.name)
    )
      return this.renderList(previous, current);
    if (
      previous.node.type.name === "list_item" &&
      current.type.name === "list_item" &&
      previous.children.length === current.childCount
    ) {
      const raw = applySourceEdits(
        this.source.slice(previous.start, previous.end),
        previous.children.map((child, index) => ({
          start: child.start - previous.start,
          end: child.end - previous.start,
          text: this.render(child, current.child(index)),
        })),
      );
      if (
        typeof previous.node.attrs["checked"] === "boolean" &&
        typeof current.attrs["checked"] === "boolean"
      )
        return raw.replace(
          /^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\])/,
          `$1${current.attrs["checked"] ? "x" : " "}$2`,
        );
    }
    if (current.type.name === "doc") return this.renderDocument(previous, current);
    if (["table_cell", "table_header"].includes(current.type.name)) {
      const schema = current.type.schema;
      const table = schema.node(
        "table",
        null,
        schema.node("table_row", null, schema.node("table_header", current.attrs, current.content)),
      );
      const line = serializeMarkdown(schema.node("doc", null, table)).split("\n")[0];
      if (line === undefined) throw new Error("无法生成表格单元格");
      const raw = this.source.slice(previous.start, previous.end);
      const leading = /^\|?[ \t]*/.exec(raw)?.[0] ?? "";
      const trailing = /[ \t]*\|?$/.exec(raw)?.[0] ?? "";
      return leading + line.slice(1, -1).trim() + trailing;
    }
    return this.replacement(current, previous.start);
  }

  private editText(previous: SourceNode, current: PmNode): string | null {
    if (!current.isTextblock || !previous.node.sameMarkup(current)) return null;
    const from = previous.node.content.findDiffStart(current.content);
    const ends = previous.node.content.findDiffEnd(current.content);
    if (from === null || ends === null) return null;
    // 相同前后缀可能重叠；两端必须同步平移，否则追加重复标点会丢掉一个字符。
    const overlap = Math.max(0, from - Math.min(ends.a, ends.b));
    const oldEnd = ends.a + overlap;
    const newEnd = ends.b + overlap;
    const changed = current.content.cut(from, newEnd);
    const range = previous.text.find((item) => {
      const original = previous.node.nodeAt(item.from);
      return (
        item.from <= from &&
        item.to >= oldEnd &&
        original !== null &&
        changed.content.every(
          (node) =>
            (node.isText || node.type.name === "hard_break") &&
            original.marks.every((mark) => mark.isInSet(node.marks)),
        )
      );
    });
    if (range === undefined) return null;
    const offsets = sourceTextOffsets(this.source.slice(range.start, range.end), range.value);
    const start = offsets?.[from - range.from];
    const end = offsets?.[oldEnd - range.from];
    if (start == null || end == null) return null;
    const original = previous.node.nodeAt(range.from);
    if (original === null) throw new Error("源码文字范围没有对应的文档节点");
    const left = previous.node.childBefore(from).node;
    const right = previous.node.childAfter(oldEnd).node;
    if (
      changed.firstChild?.marks.some(
        (mark) => !mark.isInSet(original.marks) && left !== null && mark.isInSet(left.marks),
      ) ||
      changed.lastChild?.marks.some(
        (mark) => !mark.isInSet(original.marks) && right !== null && mark.isInSet(right.marks),
      )
    )
      return null;
    const content = changed.content.map((node) =>
      node.mark(node.marks.filter((mark) => !mark.isInSet(original.marks))),
    );
    const escaped = this.inlineSource(current, content);
    return applySourceEdits(this.source.slice(previous.start, previous.end), [
      {
        start: range.start + start - previous.start,
        end: range.start + end - previous.start,
        text: escaped.replace(/(?<!\r)\n/g, this.newline),
      },
    ]);
  }

  private editPhrase(previous: SourceNode, current: PmNode): string | null {
    if (!current.isTextblock || !previous.node.sameMarkup(current)) return null;
    const from = previous.node.content.findDiffStart(current.content);
    const ends = previous.node.content.findDiffEnd(current.content);
    if (from === null || ends === null) return null;
    const overlap = Math.max(0, from - Math.min(ends.a, ends.b));
    const oldEnd = ends.a + overlap;
    const newEnd = ends.b + overlap;
    let rangeFrom = from;
    let rangeTo = oldEnd;
    const left = current.childAfter(from);
    if (left.node !== null && left.node.marks.length > 0) rangeFrom = left.offset;
    const right = current.childBefore(newEnd);
    if (right.node !== null && right.node.marks.length > 0)
      rangeTo = right.offset + right.node.nodeSize - newEnd + oldEnd;
    const affected = previous.inline.filter((item) => item.to > rangeFrom && item.from < rangeTo);
    const first = affected[0];
    const last = affected.at(-1);
    if (first === undefined || last === undefined) return null;
    const fragment = current.content.cut(first.from, last.to + newEnd - oldEnd);
    const text = this.inlineSource(current, fragment);
    return applySourceEdits(this.source.slice(previous.start, previous.end), [
      {
        start: first.start - previous.start,
        end: last.end - previous.start,
        text: text.replace(/(?<!\r)\n/g, this.newline),
      },
    ]);
  }

  private editInlineChildren(previous: SourceNode, current: PmNode): string | null {
    if (
      !current.isTextblock ||
      !previous.node.sameMarkup(current) ||
      previous.node.childCount !== current.childCount
    )
      return null;
    const edits = [];
    let position = 0;
    for (let index = 0; index < current.childCount; index++) {
      const before = previous.node.child(index);
      const after = current.child(index);
      if (!before.eq(after)) {
        if (!before.isText || !after.isText || !before.sameMarkup(after)) return null;
        const range = previous.text.find(
          (item) => item.from === position && item.to === position + before.nodeSize,
        );
        if (range === undefined) return null;
        const oldText = before.textContent;
        const newText = after.textContent;
        let from = 0;
        while (from < oldText.length && from < newText.length && oldText[from] === newText[from])
          from++;
        let suffix = 0;
        while (
          suffix < oldText.length - from &&
          suffix < newText.length - from &&
          oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
        )
          suffix++;
        const changed = newText.slice(from, newText.length - suffix);
        const offsets = sourceTextOffsets(this.source.slice(range.start, range.end), range.value);
        const start = offsets?.[from];
        const end = offsets?.[oldText.length - suffix];
        if (start == null || end == null) return null;
        const escaped = this.inlineSource(
          current,
          changed === "" ? [] : [current.type.schema.text(changed)],
        );
        edits.push({
          start: range.start + start - previous.start,
          end: range.start + end - previous.start,
          text: escaped.replace(/(?<!\r)\n/g, this.newline),
        });
      }
      position += before.nodeSize;
    }
    return edits.length > 0
      ? applySourceEdits(this.source.slice(previous.start, previous.end), edits)
      : null;
  }

  private editCode(previous: SourceNode, current: PmNode): string | null {
    if (current.type.name !== "code_block" || !previous.node.sameMarkup(current)) return null;
    const raw = this.source.slice(previous.start, previous.end);
    const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
    if (opening === null) return null;
    const closing = /(?:\r?\n)( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(raw);
    const marker = opening[2];
    if (closing === null || marker === undefined || closing[2]?.[0] !== marker[0]) return null;
    // 内容出现闭合围栏时必须扩大围栏，交由局部序列化处理，不能提前截断代码。
    if (current.textContent.split("\n").some((line) => line.trimStart().startsWith(marker)))
      return null;
    return opening[0] + current.textContent.replace(/(?<!\r)\n/g, this.newline) + closing[0];
  }

  private inlineSource(context: PmNode, content: Fragment | readonly PmNode[]): string {
    const schema = context.type.schema;
    if (["table_cell", "table_header"].includes(context.type.name)) {
      const table = schema.node(
        "table",
        null,
        schema.node("table_row", null, schema.node("table_header", context.attrs, content)),
      );
      const row = serializeMarkdown(schema.node("doc", null, table)).split("\n")[0];
      if (row === undefined) throw new Error("无法生成表格内容");
      // 表格语境负责竖线转义；仅移除序列化器增加的边框和一格填充。
      return row.slice(2, -2);
    }
    return serializeMarkdown(
      schema.node("doc", null, schema.node("paragraph", null, content)),
    ).replace(/\n$/, "");
  }

  private renderList(previous: SourceNode, current: PmNode): string {
    const first = previous.children[0];
    if (first === undefined) return this.replacement(current, previous.start);
    const firstRaw = this.source.slice(first.start, first.end);
    const marker = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(firstRaw)?.[0];
    if (marker === undefined) return this.replacement(current, previous.start);
    const indent = sourceLinePrefix(this.source, previous.start);
    const separator =
      (current.attrs["spread"] === true ? this.newline + indent : "") + this.newline + indent;
    const rendered = current.content.content
      .map((item, index) => {
        const old = previous.children.find((child) => child.node.eq(item));
        if (old !== undefined) return this.source.slice(old.start, old.end);
        const positional = previous.children[index];
        if (current.childCount === previous.node.childCount && positional !== undefined)
          return this.render(positional, item);
        const wrapper = current.type.create(current.attrs, item);
        const generated = this.replacement(wrapper, previous.start);
        return generated.replace(/^(?:[-*+]|\d+[.)])[ \t]+/, marker);
      })
      .join(separator);
    return this.listStart(current, rendered);
  }

  private listStart(node: PmNode, source: string): string {
    return node.type.name === "ordered_list"
      ? source.replace(/^\d+/, String(node.attrs["order"]))
      : source;
  }

  private replacement(node: PmNode, at: number): string {
    let root = node;
    if (node.type.name === "list_item") root = node.type.schema.node("bullet_list", null, node);
    let text = serializeMarkdown(node.type.schema.node("doc", null, root)).replace(/\n$/, "");
    if (node.type.name === "list_item") {
      const marker = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(this.source.slice(at))?.[0];
      if (marker !== undefined) {
        text = text.replace(/^-[ \t]+/, marker);
        if (marker.length > 2) text = text.replace(/\n/g, `\n${" ".repeat(marker.length - 2)}`);
      }
    }
    const prefix = sourceLinePrefix(this.source, at);
    // 嵌套块的范围从首行正文开始；后续行仍需携带引用标记或列表缩进。
    const continuation = /^[\s>*+\-\d.()[\]xX]*$/.test(prefix)
      ? prefix.replace(/[^\s>]/g, " ")
      : "";
    return text.replace(/(?<!\r)\n/g, `${this.newline}${continuation}`);
  }

  private renderDocument(previous: SourceNode, current: PmNode): string {
    const before = previous.children;
    const after = current.content.content;
    if (before.length === 0)
      return serializeMarkdown(current)
        .replace(/\n$/, "")
        .replace(/(?<!\r)\n/g, this.newline);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && sameAt(before, prefix, after, prefix))
      prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      sameAt(before, before.length - suffix - 1, after, after.length - suffix - 1)
    )
      suffix++;
    const oldMiddle = before.slice(prefix, before.length - suffix);
    const newMiddle = after.slice(prefix, after.length - suffix);
    if (oldMiddle.length === newMiddle.length) {
      return applySourceEdits(
        this.source.slice(this.bom),
        oldMiddle.map((item, index) => ({
          start: item.start - this.bom,
          end: item.end - this.bom,
          text: this.render(item, requiredNode(newMiddle, index)),
        })),
      );
    }
    const next = before[before.length - suffix];
    const prior = before[prefix - 1];
    const start = oldMiddle[0]?.start ?? next?.start ?? prior?.end ?? this.bom;
    const end = oldMiddle.at(-1)?.end ?? start;
    const text = newMiddle
      .map((node) => {
        const original = before.find((item) => item.node.eq(node));
        return original === undefined
          ? this.replacement(node, this.bom)
          : this.source.slice(original.start, original.end);
      })
      .join(this.newline + this.newline);
    const inserted =
      oldMiddle.length === 0 && text !== ""
        ? next === undefined
          ? this.newline + this.newline + text
          : text + this.newline + this.newline
        : text;
    return applySourceEdits(this.source.slice(this.bom), [
      { start: start - this.bom, end: end - this.bom, text: inserted },
    ]);
  }
}

function requiredNode(nodes: readonly PmNode[], index: number): PmNode {
  const node = nodes[index];
  if (node === undefined) throw new Error("源码映射与文档结构不一致");
  return node;
}

function sameAt(
  before: readonly SourceNode[],
  left: number,
  after: readonly PmNode[],
  right: number,
): boolean {
  const original = before[left];
  const current = after[right];
  return original !== undefined && current !== undefined && original.node.eq(current);
}
