/** Markdown 映射到编辑器；暂未提供富文本编辑的语法以可保留的源码节点承载。 */
import type { Blockquote, Definition, Nodes, PhrasingContent, RootContent } from "mdast";
import { decodeString } from "micromark-util-decode-string";
import type { Mark, Node as PmNode } from "prosemirror-model";
import { markdownProcessor } from "./markdown-processor";
import { previewKindFromReference } from "../preview/media";
import { noteEmbedFromParagraph } from "./embed";
import { documentSchema } from "./schema";

type Definitions = ReadonlyMap<string, Definition>;

/**
 * 把 Markdown 映射为文档，引用定义与脚注等未支持的节点也必须保留。
 *
 * 独立成段的 `![[笔记]]` 在顶层、引用块与列表项内都提升为嵌入块；
 * 嵌套深度与循环的控制在内容视图层执行（见 `content-view`），
 * 解析层始终产出完整结构。
 *
 * @param source Markdown 原文。
 * @returns schema 约束下的文档节点。
 * @throws 语法无法被处理器承载时失败，禁止静默丢弃内容。
 */
export function parseMarkdown(source: string): PmNode {
  const tree = markdownProcessor.parse(source);
  const definitions = new Map<string, Definition>();
  collectDefinitions(tree, definitions);
  const lifted = tree.children.map((node) => mapBlock(node, definitions)).map(liftEmbedParagraph);
  // 仅有属性的文件仍需可落笔的正文；空段不产生源码，首次输入才追加内容。
  if (tree.children.length === 1 && tree.children[0]?.type === "yaml") lifted.push(paragraph());
  return documentSchema.node("doc", null, lifted.length === 0 ? [paragraph()] : lifted);
}

/** 只含一条笔记嵌入的段落提升为嵌入块；句中嵌入保持链接，避免拆开句子。 */
function liftEmbedParagraph(block: PmNode): PmNode {
  if (block.type.name !== "paragraph") return block;
  return noteEmbedFromParagraph(block) ?? block;
}

function collectDefinitions(node: Nodes, definitions: Map<string, Definition>): void {
  if (node.type === "definition" && !definitions.has(node.identifier)) {
    definitions.set(node.identifier, node);
  }
  if ("children" in node) {
    for (const child of node.children) collectDefinitions(child, definitions);
  }
}

function paragraph(content: PmNode[] = []): PmNode {
  return documentSchema.node("paragraph", null, content);
}

function mapBlock(node: RootContent, definitions: Definitions): PmNode {
  switch (node.type) {
    case "heading":
      return documentSchema.node(
        "heading",
        { level: node.depth },
        mapPhrasing(node.children, definitions),
      );
    case "paragraph": {
      // 独占一段的注释是块注释；句中注释保持行内。
      const only = node.children.length === 1 ? node.children[0] : undefined;
      if (only?.type === "comment")
        return documentSchema.node("comment_block", { source: only.value });
      return paragraph(mapPhrasing(node.children, definitions));
    }
    case "footnoteDefinition": {
      const children = node.children
        .map((child) => mapBlock(child, definitions))
        .map(liftEmbedParagraph);
      return documentSchema.node(
        "footnote_def",
        { label: node.label ?? node.identifier },
        children.length === 0 ? [paragraph()] : children,
      );
    }
    case "blockquote": {
      const callout = calloutBlock(node, definitions);
      if (callout !== null) return callout;
      const children = node.children
        .map((child) => mapBlock(child, definitions))
        .map(liftEmbedParagraph);
      return documentSchema.node(
        "blockquote",
        null,
        children.length === 0 ? [paragraph()] : children,
      );
    }
    case "list": {
      const items = node.children.map((item) => {
        const children = item.children
          .map((child) => mapBlock(child, definitions))
          .map(liftEmbedParagraph);
        // 列表项以段落或嵌入块开始；空首项与以子列表开头的项补空段落。
        const first = children[0]?.type.name;
        if (first !== "paragraph" && first !== "note_embed") children.unshift(paragraph());
        return documentSchema.node(
          "list_item",
          {
            checked: item.checked ?? null,
            spread: item.spread ?? false,
          },
          children,
        );
      });
      return documentSchema.node(
        node.ordered ? "ordered_list" : "bullet_list",
        {
          order: node.start ?? 1,
          spread: node.spread ?? false,
        },
        items,
      );
    }
    case "code":
      return documentSchema.node(
        "code_block",
        { params: node.lang ?? "", meta: node.meta ?? null },
        text(node.value),
      );
    case "thematicBreak":
      return documentSchema.node("horizontal_rule");
    case "html":
      return documentSchema.node("html_block", { html: node.value });
    case "math":
      return documentSchema.node("math_block", { tex: node.value });
    case "table":
      return documentSchema.node(
        "table",
        null,
        node.children.map((row, rowIndex) =>
          documentSchema.node(
            "table_row",
            null,
            row.children.map((cell, colIndex) =>
              documentSchema.node(
                rowIndex === 0 ? "table_header" : "table_cell",
                {
                  align: node.align?.[colIndex] ?? null,
                },
                mapPhrasing(cell.children, definitions, [], true),
              ),
            ),
          ),
        ),
      );
    default:
      return sourceNode(node, true);
  }
}

function mapPhrasing(
  nodes: PhrasingContent[],
  definitions: Definitions,
  marks: readonly Mark[] = [],
  table = false,
): PmNode[] {
  const out: PmNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.type === "html" && table && /^<br\s*\/?>$/i.test(node.value)) {
      out.push(documentSchema.node("hard_break").mark(marks));
    } else if (node.type === "html") {
      let html = node.value;
      let next = nodes[index + 1];
      // 相邻开闭标签必须一起预览，否则空锚点等 HTML 会被拆坏。
      while (next?.type === "html" && !(table && /^<br\s*\/?>$/i.test(next.value))) {
        html += next.value;
        index += 1;
        next = nodes[index + 1];
      }
      out.push(documentSchema.node("html_inline", { html }).mark(marks));
    } else {
      out.push(...mapPhrase(node, definitions, marks, table));
    }
  }
  return out;
}

function mapPhrase(
  node: PhrasingContent,
  definitions: Definitions,
  marks: readonly Mark[],
  table: boolean,
): PmNode[] {
  switch (node.type) {
    case "text":
      return text(node.value, marks);
    case "strong":
    case "emphasis":
    case "delete":
    case "highlight": {
      const name =
        node.type === "strong"
          ? "strong"
          : node.type === "emphasis"
            ? "em"
            : node.type === "delete"
              ? "strike"
              : "highlight";
      return mapPhrasing(node.children, definitions, [...marks, documentSchema.mark(name)], table);
    }
    case "comment":
      return [documentSchema.node("comment_inline", { source: node.value }).mark(marks)];
    case "footnoteReference":
      return [
        documentSchema.node("footnote_ref", { label: node.label ?? node.identifier }).mark(marks),
      ];
    case "inlineCode":
      return text(node.value, [...marks, documentSchema.mark("code")]);
    case "break":
      return [documentSchema.node("hard_break").mark(marks)];
    case "link":
    case "linkReference": {
      const definition = node.type === "linkReference" ? definitions.get(node.identifier) : node;
      if (definition === undefined) return [sourceNode(node, false).mark(marks)];
      const link = documentSchema.mark("link", {
        href: definition.url,
        title: definition.title ?? null,
        reference: node.type === "linkReference" ? node.identifier : null,
      });
      return mapPhrasing(node.children, definitions, [...marks, link], table);
    }
    case "image":
    case "imageReference": {
      const definition = node.type === "imageReference" ? definitions.get(node.identifier) : node;
      if (definition === undefined) return [sourceNode(node, false).mark(marks)];
      return [
        documentSchema
          .node(previewKindFromReference(definition.url) ?? "image", {
            src: definition.url,
            alt: node.alt ?? "",
            title: definition.title ?? null,
            kind: "md",
            reference: node.type === "imageReference" ? node.identifier : null,
          })
          .mark(marks),
      ];
    }
    case "wikiLink":
      return wikiNodes(node.value, marks);
    case "inlineMath":
      return [documentSchema.node("math_inline", { tex: node.value }).mark(marks)];
    default:
      return [sourceNode(node, false).mark(marks)];
  }
}

/** 首行 `[!kind]±` 标记；类型不含空白与方括号，标题是标记后的剩余首行。 */
const CALLOUT_MARKER = /^\[!([^\]\s]+)\]([+-]?)(?:[ \t]+|(?=\n)|$)/;

/**
 * 首段以 `[!kind]` 开头的引用块是 Obsidian 标注。
 *
 * 首段的首行是标记与标题，同段的后续行是正文首段；标题按行内 Markdown 原样
 * 保存在属性里，序列化时写回首行。不符合标记格式时返回 null，按普通引用处理。
 */
function calloutBlock(node: Blockquote, definitions: Definitions): PmNode | null {
  const first = node.children[0];
  const lead = first?.type === "paragraph" ? first.children[0] : undefined;
  if (first?.type !== "paragraph" || lead?.type !== "text") return null;
  const match = CALLOUT_MARKER.exec(lead.value);
  if (match === null) return null;
  const title: PhrasingContent[] = [];
  const rest: PhrasingContent[] = [];
  let body = false;
  first.children.forEach((child, index) => {
    if (body) {
      rest.push(child);
      return;
    }
    const current: PhrasingContent =
      index === 0 ? { type: "text", value: lead.value.slice(match[0].length) } : child;
    const newline = current.type === "text" ? current.value.indexOf("\n") : -1;
    if (current.type !== "text" || newline < 0) {
      title.push(current);
      return;
    }
    const head = current.value.slice(0, newline);
    const tail = current.value.slice(newline + 1);
    if (head !== "") title.push({ type: "text", value: head });
    if (tail !== "") rest.push({ type: "text", value: tail });
    body = true;
  });
  const titleSource =
    title.length === 0
      ? ""
      : markdownProcessor
          .stringify({ type: "root", children: [{ type: "paragraph", children: title }] })
          .trim();
  const children = [
    ...(rest.length === 0 ? [] : [paragraph(mapPhrasing(rest, definitions))]),
    ...node.children
      .slice(1)
      .map((child) => mapBlock(child, definitions))
      .map(liftEmbedParagraph),
  ];
  return documentSchema.node(
    "callout",
    { kind: match[1] ?? "note", fold: match[2] ?? "", title: titleSource },
    children.length === 0 ? [paragraph()] : children,
  );
}

function wikiNodes(raw: string, marks: readonly Mark[]): PmNode[] {
  const embed = raw.startsWith("!");
  const inner = decodeString(raw.slice(embed ? 3 : 2, -2));
  const separator = inner.indexOf("|");
  const target = (separator < 0 ? inner : inner.slice(0, separator)).trim();
  const alias = separator < 0 ? null : inner.slice(separator + 1);
  if (target === "") return text(raw, marks);
  const previewKind = embed ? previewKindFromReference(target) : null;
  if (previewKind !== null) {
    return [
      documentSchema
        .node(previewKind, {
          src: target,
          alt: alias ?? "",
          kind: "wiki",
        })
        .mark(marks),
    ];
  }
  const link = documentSchema.node("wiki_link", { target, alias }).mark(marks);
  return embed ? [...text("!", marks), link] : [link];
}

function text(value: string, marks: readonly Mark[] = []): PmNode[] {
  return value === "" ? [] : [documentSchema.text(value, marks)];
}

function sourceNode(node: RootContent, block: boolean): PmNode {
  // 处理器去除外层引用/列表的缩进；保存时由实际父节点重新施加，避免重复前缀。
  const source = markdownProcessor.stringify({ type: "root", children: [node] }).trimEnd();
  return block
    ? documentSchema.node("markdown_block", null, text(source))
    : documentSchema.node("markdown_inline", { source });
}
