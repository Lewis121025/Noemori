/**
 * 可被 `^块` 引用的段落清单与块 ID 写入。
 *
 * 规则与跳转（`block-anchor.ts`）一致：块 ID 写在段落末尾（`文字 ^id`），
 * 或单独成段紧跟在目标段落之后（`^id`）。清单覆盖所有段落，包括列表项、
 * 引用块与标注里的段落；新 ID 追加在段落末尾。
 */

import type { Node as PmNode } from "prosemirror-model";
import type { Nodes } from "mdast";
import { toString } from "mdast-util-to-string";
import { markdownProcessor } from "../markdown/markdown-processor";

/** 段落末尾的块 ID；标识只接受字母、数字与连字符。 */
const TRAILING_ID = /(?:^|\s)\^([A-Za-z0-9-]+)$/;
/** 单独成段的块 ID。 */
const STANDALONE_ID = /^\^([A-Za-z0-9-]+)$/;
/** 候选展示文字的长度上限。 */
const PREVIEW_LENGTH = 80;

/** 块补全的目标：本笔记在编辑器内处理（含未保存编辑），其他笔记按磁盘源码处理。 */
export type BlockTarget =
  { kind: "self" } | { kind: "file"; path: string; blocks: BlockCandidate[] };

/** 一个可引用的块。 */
export type BlockCandidate = {
  /** 在清单中的序号；写入前据此核对目标是否仍是同一段。 */
  index: number;
  /** 段落纯文本（去掉块 ID，折叠空白，截断）。 */
  text: string;
  /** 已有块 ID；没有时为 null。 */
  id: string | null;
  /** 追加 ` ^id` 的位置：源码清单是 UTF-16 偏移，文档清单是 ProseMirror 位置。 */
  insertAt: number;
};

function summarize(raw: string): { text: string; id: string | null } {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const match = TRAILING_ID.exec(collapsed);
  const text = match === null ? collapsed : collapsed.slice(0, match.index).trim();
  return {
    text: text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text,
    id: match?.[1] ?? null,
  };
}

/** 按段落顺序收集，把单独成段的 ID 归给前一段。 */
function collect(paragraphs: Iterable<{ raw: string; insertAt: number }>): BlockCandidate[] {
  const out: BlockCandidate[] = [];
  for (const paragraph of paragraphs) {
    const standalone = STANDALONE_ID.exec(paragraph.raw.trim());
    if (standalone !== null) {
      const previous = out.at(-1);
      if (previous !== undefined && previous.id === null) previous.id = standalone[1] ?? null;
      continue;
    }
    const { text, id } = summarize(paragraph.raw);
    if (text === "" && id === null) continue;
    out.push({ index: out.length, text, id, insertAt: paragraph.insertAt });
  }
  return out;
}

/**
 * 从 Markdown 源码列出可引用的块。
 *
 * @param source 完整源码，允许带 BOM。
 * @returns 按文档顺序的块；`insertAt` 是段落正文末尾的 UTF-16 偏移。
 */
export function listSourceBlocks(source: string): BlockCandidate[] {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const tree = markdownProcessor.parse(source.slice(bom));
  const paragraphs: Array<{ raw: string; insertAt: number }> = [];
  const visit = (node: Nodes): void => {
    if (node.type === "paragraph") {
      const end = node.position?.end.offset;
      if (end !== undefined) paragraphs.push({ raw: toString(node), insertAt: end + bom });
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return collect(paragraphs);
}

/**
 * 从文档树列出可引用的块（引用本笔记时使用，包含尚未保存的编辑）。
 *
 * @returns `insertAt` 是段落内容末尾的文档位置。
 */
export function listDocBlocks(doc: PmNode): BlockCandidate[] {
  const paragraphs: Array<{ raw: string; insertAt: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return true;
    paragraphs.push({ raw: node.textContent, insertAt: pos + node.nodeSize - 1 });
    return false;
  });
  return collect(paragraphs);
}

/**
 * 生成文件内唯一的 6 位 base36 块 ID。
 *
 * @param taken 文件里已有的块 ID。
 * @param random 随机源，测试注入。
 */
export function newBlockId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    let id = "";
    while (id.length < 6) id += Math.floor(random() * 36).toString(36);
    if (!taken.has(id)) return id;
  }
}

/** 块清单里已占用的 ID。 */
export function takenBlockIds(blocks: readonly BlockCandidate[]): Set<string> {
  return new Set(blocks.flatMap((block) => (block.id === null ? [] : [block.id])));
}

/**
 * 在源码里给块追加 ID。
 *
 * @returns 只在段落末尾插入 ` ^id` 的新源码，其余字节不变。
 */
export function withBlockId(source: string, block: BlockCandidate, id: string): string {
  return `${source.slice(0, block.insertAt)} ^${id}${source.slice(block.insertAt)}`;
}
