import type {
  Definition,
  FootnoteDefinition,
  FootnoteReference,
  Heading,
  Nodes,
  Paragraph,
  Root,
} from "mdast";
import { toString } from "mdast-util-to-string";
import { markdownProcessor } from "../../reader/shared/markdown/markdown-processor";
import { restoreTextStyles } from "../../reader/shared/markdown/text-style";
import { contentKind, remoteContentUrl } from "../shared/content";

/** 地址先按协议分类，再决定呈现方式；锚点与邮件地址不能按文件扩展名分流。 */
type MessageLink =
  | { kind: "anchor"; fragment: string }
  | { kind: "external" | "content"; url: string; title: string | null };
/** 同一消息内的脚注；编号按首次引用排序，每次引用都有独立返回锚点。 */
type Footnote = { node: FootnoteDefinition; number: number; references: number };
/** 定义保持原始语义；呈现索引只包含正文与实际引用的脚注，不读取任何链接资源。 */
type Definitions = { links: Map<string, Definition>; notes: Map<string, FootnoteDefinition> };
/** 消息语法树与派生索引同生共灭，流式更新不会复用过期的定义或节点位置。 */
export type MessageMarkdown = {
  tree: Root;
  links: ReadonlyMap<Nodes, MessageLink>;
  richParagraphs: ReadonlySet<Paragraph>;
  footnotes: readonly Footnote[];
  references: ReadonlyMap<FootnoteReference, { number: number; occurrence: number }>;
  headings: ReadonlyMap<Heading, string>;
};

function identifier(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toUpperCase();
}

function visitNodes(node: Nodes, visit: (node: Nodes) => boolean | void): void {
  if (visit(node) === false) return;
  if ("children" in node) node.children.forEach((child) => visitNodes(child, visit));
}

function collectDefinitions(tree: Root): Definitions {
  const links = new Map<string, Definition>(),
    notes = new Map<string, FootnoteDefinition>();
  visitNodes(tree, (node) => {
    if (node.type === "definition" && !links.has(identifier(node.identifier)))
      links.set(identifier(node.identifier), node);
    if (node.type === "footnoteDefinition" && !notes.has(identifier(node.identifier)))
      notes.set(identifier(node.identifier), node);
  });
  return { links, notes };
}

function collectFootnotes(tree: Root, definitions: Definitions) {
  const footnotes: Footnote[] = [];
  const ordered = new Map<FootnoteDefinition, Footnote>();
  const references = new Map<FootnoteReference, { number: number; occurrence: number }>();
  function reference(node: Nodes): boolean | void {
    if (node.type === "footnoteDefinition") return false;
    if (node.type !== "footnoteReference") return;
    const definition = definitions.notes.get(identifier(node.identifier));
    if (!definition) return;
    let note = ordered.get(definition);
    if (!note) {
      note = { node: definition, number: footnotes.length + 1, references: 0 };
      ordered.set(definition, note);
      footnotes.push(note);
    }
    references.set(node, { number: note.number, occurrence: ++note.references });
  }
  visitNodes(tree, reference);
  // 数组迭代包含新发现的脚注；每条定义只访问一次，循环引用不会递归失控。
  for (const note of footnotes) note.node.children.forEach((node) => visitNodes(node, reference));
  return { footnotes, references };
}

function resolveLink(node: Nodes, definitions: Definitions): MessageLink | null {
  const target =
    node.type === "link" || node.type === "image"
      ? node
      : node.type === "linkReference" || node.type === "imageReference"
        ? definitions.links.get(identifier(node.identifier))
        : undefined;
  if (
    !target?.url ||
    [...target.url].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  const image = node.type === "image" || node.type === "imageReference";
  if (target.url.startsWith("#")) {
    if (image) return null;
    const fragment = target.url.slice(1);
    try {
      return { kind: "anchor", fragment: decodeURIComponent(fragment) };
    } catch {
      return { kind: "anchor", fragment };
    }
  }
  let url: URL;
  try {
    url = new URL(target.url, "file:///");
  } catch {
    return null;
  }
  const title = target.title ?? null;
  if (url.protocol === "mailto:") return image ? null : { kind: "external", url: url.href, title };
  const remote = remoteContentUrl(target.url);
  const local = url.protocol === "file:" && (!url.hostname || url.hostname === "localhost");
  if (!remote && !local) return null;
  if (image || contentKind(url.pathname)) return { kind: "content", url: target.url, title };
  return remote ? { kind: "external", url: remote, title } : null;
}

function headingSlug(node: Heading, used: Map<string, number>): string {
  const base =
    toString(node)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, "")
      .replace(/\s/gu, "-") || "section";
  let slug = base,
    suffix = used.get(base) ?? 0;
  // 记录每个标题的下一个候选编号，重复标题不会从 1 重新扫描全部已有锚点。
  while (used.has(slug)) slug = `${base}-${++suffix}`;
  used.set(base, suffix);
  used.set(slug, 0);
  return slug;
}

function indexPresentation(tree: Root, footnotes: readonly Footnote[], definitions: Definitions) {
  const links = new Map<Nodes, MessageLink>();
  const headings = new Map<Heading, string>(),
    slugs = new Map<string, number>();
  const richParagraphs = new Set<Paragraph>();
  function index(node: Nodes): boolean {
    if (node.type === "definition" || node.type === "footnoteDefinition" || node.type === "comment")
      return false;
    const link = resolveLink(node, definitions);
    if (link) links.set(node, link);
    if (node.type === "heading") headings.set(node, headingSlug(node, slugs));
    let preview = link?.kind === "content";
    if ("children" in node) {
      for (const child of node.children) preview = index(child) || preview;
    }
    if (node.type === "paragraph" && preview) richParagraphs.add(node);
    return preview;
  }
  index(tree);
  for (const note of footnotes) note.node.children.forEach(index);
  return { links, headings, richParagraphs };
}

/**
 * 解析当前消息快照，依次建立定义、引用顺序与实际呈现内容的索引。
 * @param source 完整消息文本，允许未闭合的流式 Markdown，不改写输入。
 * @returns 同一快照的语法树与显示索引，链接和段落结构只计算一次。
 * @throws 解析器发生内部错误时保留原始异常。
 */
export function parseMessageMarkdown(source: string): MessageMarkdown {
  const tree = markdownProcessor.parse(source);
  restoreTextStyles(tree);
  const definitions = collectDefinitions(tree);
  const notes = collectFootnotes(tree, definitions);
  return { tree, ...notes, ...indexPresentation(tree, notes.footnotes, definitions) };
}
