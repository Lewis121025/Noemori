import type { Node as PmNode } from "prosemirror-model";
import type { Nodes } from "mdast";
import { sourceTextOffsets } from "./source-text";

/** 原始语法与编辑器节点的只读范围；位置统一采用 UTF-16。 */
export type SourceNode = {
  node: PmNode;
  start: number;
  end: number;
  children: SourceNode[];
  text: Array<{ from: number; to: number; start: number; end: number; value: string }>;
  inline: Array<{ from: number; to: number; start: number; end: number }>;
  /** 列表 schema 补入的空首段没有原始字节，但必须占据文档位置。 */
  implicit?: boolean;
};
type Edit = { start: number; end: number; text: string };

/** 配对解析树与文档节点；解析器缺失范围时抛错，不猜测源码位置。 */
export function sourceTree(ast: Nodes, node: PmNode, offset: number): SourceNode {
  const start = ast.position?.start.offset;
  const end = ast.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error("Markdown 缺少源码范围");
  // 标注的首段在语法树里还包着 `[!kind]` 标题行，与文档子节点不能逐一配对；
  // 整块作为叶子，内部编辑时整块重写。
  const branch =
    ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(ast.type) &&
    node.type.name !== "callout";
  let children =
    branch && "children" in ast && ast.children.length === node.childCount
      ? ast.children.map((child, index) => sourceTree(child, node.child(index), offset))
      : [];
  if (
    ast.type === "listItem" &&
    ast.children.length > 0 &&
    ast.children[0]?.type !== "paragraph" &&
    node.childCount === ast.children.length + 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.content.size === 0
  ) {
    children = ast.children.map((child, index) => sourceTree(child, node.child(index + 1), offset));
    const at = children[0]?.start ?? start + offset;
    children.unshift({
      node: node.firstChild,
      start: at,
      end: at,
      children: [],
      text: [],
      inline: [],
      implicit: true,
    });
  }
  const text: SourceNode["text"] = [];
  const phrases: SourceNode["inline"] = [];
  let position = 0;
  function inline(item: Nodes): void {
    if (item.type === "text") {
      const start = item.position?.start.offset;
      const end = item.position?.end.offset;
      if (start !== undefined && end !== undefined)
        text.push({
          from: position,
          to: position + item.value.length,
          start: start + offset,
          end: end + offset,
          value: item.value,
        });
      position += item.value.length;
    } else if (item.type === "inlineCode") position += item.value.length;
    else if ("children" in item) item.children.forEach(inline);
    else position += 1;
  }
  if (node.isTextblock && "children" in ast) {
    for (const item of ast.children) {
      const from = position;
      inline(item);
      const start = item.position?.start.offset;
      const end = item.position?.end.offset;
      if (start !== undefined && end !== undefined)
        phrases.push({ from, to: position, start: start + offset, end: end + offset });
    }
  }
  return {
    node,
    start: start + offset,
    end: end + offset,
    children,
    text: position === node.content.size ? text : [],
    inline: position === node.content.size ? phrases : [],
  };
}

/** 按有序且互不相交的 UTF-16 区间替换源码；重叠或越界时抛错。 */
export function applySourceEdits(source: string, edits: Edit[]): string {
  let end = 0;
  let result = "";
  for (const edit of edits) {
    if (edit.start < end || edit.end < edit.start || edit.end > source.length)
      throw new Error("源码修改范围重叠或越界，已停止保存");
    result += source.slice(end, edit.start) + edit.text;
    end = edit.end;
  }
  return result + source.slice(end);
}

/** 将原始源码位置映射到初始文档的最小语法块，返回 ProseMirror 位置。 */
export function positionInTree(
  tree: SourceNode,
  source: string,
  offset: number,
  position: number,
): number {
  let childPosition = position + 1;
  for (const child of tree.children) {
    if (!child.implicit && offset >= child.start && offset <= child.end)
      return positionInTree(child, source, offset, childPosition);
    childPosition += child.node.nodeSize;
  }
  const text = tree.text.find((item) => offset >= item.start && offset <= item.end);
  if (text !== undefined) {
    const offsets = sourceTextOffsets(source.slice(text.start, text.end), text.value);
    if (offsets !== null) {
      let relative = 0;
      for (const [index, raw] of offsets.entries()) {
        if (raw === null) continue;
        if (raw > offset - text.start) break;
        relative = index;
      }
      return position + 1 + text.from + relative;
    }
  }
  return Math.max(0, position + (tree.node.isTextblock ? 1 : 0));
}
