import type { Node as PmNode } from "prosemirror-model";
import type { Nodes } from "mdast";
import { sourceCodeOffsets, sourceTextOffsets } from "./source-text";

/** 原始语法与编辑器节点的只读范围；位置统一采用 UTF-16。 */
export type SourceNode = {
  node: PmNode;
  start: number;
  end: number;
  children: SourceNode[];
  text: Array<{ from: number; to: number; start: number; end: number; value: string }>;
  inline: Array<{ from: number; to: number; start: number; end: number }>;
  /** 仅供精确导航使用；不参与保真保存的文本替换。 */
  navigation?: Array<{
    from: number;
    to: number;
    start: number;
    end: number;
    kind: "code" | "inlineCode" | "atom";
    value: string;
  }>;
  /** 无原始字节的空段：leading 为列表首段，trailing 为仅属性文档的正文入口。 */
  implicit?: "leading" | "trailing";
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
    ["root", "blockquote", "list", "listItem", "footnoteDefinition", "table", "tableRow"].includes(
      ast.type,
    ) && node.type.name !== "callout";
  let children =
    branch && "children" in ast && ast.children.length === node.childCount
      ? ast.children.map((child, index) => sourceTree(child, node.child(index), offset))
      : [];
  if (
    ast.type === "root" &&
    ast.children.length === 1 &&
    ast.children[0]?.type === "yaml" &&
    node.childCount === 2 &&
    node.lastChild?.type.name === "paragraph" &&
    node.lastChild.content.size === 0
  ) {
    children = [
      sourceTree(ast.children[0], node.child(0), offset),
      {
        node: node.lastChild,
        start: end + offset,
        end: end + offset,
        children: [],
        text: [],
        inline: [],
        implicit: "trailing",
      },
    ];
  }
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
      implicit: "leading",
    });
  }
  if (branch && children.length !== node.childCount)
    throw new Error("Markdown 块与编辑器布局无法对应，已停止生成源码位置");
  const text: SourceNode["text"] = [];
  const phrases: SourceNode["inline"] = [];
  const navigation: NonNullable<SourceNode["navigation"]> = [];
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
    } else if (item.type === "inlineCode") {
      const start = item.position?.start.offset;
      const end = item.position?.end.offset;
      if (start !== undefined && end !== undefined)
        navigation.push({
          from: position,
          to: position + item.value.length,
          start: start + offset,
          end: end + offset,
          kind: "inlineCode",
          value: item.value,
        });
      position += item.value.length;
    } else if ("children" in item) item.children.forEach(inline);
    else {
      const start = item.position?.start.offset;
      const end = item.position?.end.offset;
      if (start !== undefined && end !== undefined)
        navigation.push({
          from: position,
          to: position + 1,
          start: start + offset,
          end: end + offset,
          kind: "atom",
          value: "",
        });
      position += 1;
    }
  }
  if (ast.type === "code" && node.type.name === "code_block") {
    position = node.content.size;
    navigation.push({
      from: 0,
      to: position,
      start: start + offset,
      end: end + offset,
      kind: "code",
      value: ast.value,
    });
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
    navigation: position === node.content.size ? navigation : [],
  };
}

/**
 * 将同一快照中的源码范围精确映射为文档选区；无法验证的语法边界返回 null。
 * @param tree 与 source 对应的解析树。
 * @param source 完整原文；start/end 使用 UTF-16，终点不含。
 * @returns 文本或原子节点的完整选区；不会降级到段落开头。
 */
export function rangeInTree(
  tree: SourceNode,
  source: string,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const from = exactPosition(tree, source, start, -1, false);
  const to = exactPosition(tree, source, end, -1, true);
  return from !== null && to !== null && from < to ? { from, to } : null;
}

function exactPosition(
  tree: SourceNode,
  source: string,
  offset: number,
  position: number,
  end: boolean,
): number | null {
  let childPosition = position + 1;
  for (const child of tree.children) {
    if (!child.implicit && offset >= child.start && offset <= child.end) {
      const found = exactPosition(child, source, offset, childPosition, end);
      if (found !== null) return found;
    }
    childPosition += child.node.nodeSize;
  }
  for (const item of [...tree.text, ...(tree.navigation ?? [])]) {
    if (offset < item.start || offset > item.end) continue;
    if ("kind" in item && item.kind === "atom") return position + 1 + (end ? item.to : item.from);
    const raw = source.slice(item.start, item.end);
    const offsets =
      "kind" in item
        ? sourceCodeOffsets(raw, item.value, item.kind === "inlineCode")
        : sourceTextOffsets(raw, item.value);
    const index = offsets?.indexOf(offset - item.start) ?? -1;
    if (index >= 0) return position + 1 + item.from + index;
  }
  return null;
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
  const text = [...tree.text, ...(tree.navigation ?? [])].find(
    (item) => offset >= item.start && offset <= item.end,
  );
  if (text !== undefined) {
    if ("kind" in text && text.kind === "atom") return position + 1 + text.from;
    const raw = source.slice(text.start, text.end);
    const offsets =
      "kind" in text
        ? sourceCodeOffsets(raw, text.value, text.kind === "inlineCode")
        : sourceTextOffsets(raw, text.value);
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

/**
 * 将同一快照的排版位置反向映射到 UTF-16 源码；不透明语法落在所属块边界。
 * @param target 当前树中的 ProseMirror 位置；调用方负责检查快照版本与范围。
 * @returns 源码偏移，供视图交接与阅读锚点使用，不用于改写源文件。
 */
export function sourceOffsetInTree(
  tree: SourceNode,
  source: string,
  target: number,
  position = -1,
): number {
  let childPosition = position + 1;
  for (const child of tree.children) {
    if (target >= childPosition && target < childPosition + child.node.nodeSize)
      return sourceOffsetInTree(child, source, target, childPosition);
    childPosition += child.node.nodeSize;
  }
  const relative = target - position - 1;
  const parts = [...tree.text, ...(tree.navigation ?? [])];
  const part =
    parts.find((item) => relative >= item.from && relative < item.to) ??
    parts.find((item) => relative === item.to);
  if (part !== undefined) {
    if ("kind" in part && part.kind === "atom") return relative === part.to ? part.end : part.start;
    const raw = source.slice(part.start, part.end);
    const offsets =
      "kind" in part
        ? sourceCodeOffsets(raw, part.value, part.kind === "inlineCode")
        : sourceTextOffsets(raw, part.value);
    const offset = offsets?.[relative - part.from];
    if (offset !== undefined && offset !== null) return part.start + offset;
  }
  return relative >= tree.node.content.size ? tree.end : tree.start;
}
