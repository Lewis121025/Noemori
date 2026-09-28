/**
 * 把提及记录定位到 ProseMirror 文档位置，或把 UTF-8 字节换成 JS 下标。
 */

import type { Node as PmNode } from "prosemirror-model";
import type { MentionRecord } from "../../../shared/api";
export { utf8ByteToJsIndex } from "../document/source-offset";

/**
 * 在文档里找第 `occurrence` 次（从 1 计）对应节点/文本的位置。
 *
 * @param doc 当前 ProseMirror 文档。
 * @param mention 要跳转的提及。
 * @param occurrence 同一文件里同类命中的次序。
 * @returns 节点或文本起点；找不到为 `null`。
 */
export function findMentionPmPos(
  doc: PmNode,
  mention: Pick<MentionRecord, "kind" | "linkKind" | "toRaw">,
  occurrence: number,
): number | null {
  if (occurrence < 1) {
    return null;
  }
  if (mention.kind === "linked" && mention.linkKind === "wiki") {
    return findNthWiki(doc, mention.toRaw, occurrence);
  }
  if (mention.kind === "linked" && mention.linkKind === "md") {
    return findNthMdLink(doc, mention.toRaw, occurrence);
  }
  return findNthUnlinkedText(doc, mention.toRaw, occurrence);
}

function findNthWiki(doc: PmNode, target: string, occurrence: number): number | null {
  let seen = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (node.type.name === "wiki_link" && String(node.attrs["target"] ?? "") === target) {
      seen += 1;
      if (seen === occurrence) {
        found = pos;
      }
    }
    return true;
  });
  return found;
}

function findNthMdLink(doc: PmNode, href: string, occurrence: number): number | null {
  let seen = 0;
  let inRun = false;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (node.isBlock) {
      inRun = false;
      return true;
    }
    if (!node.isText) {
      return true;
    }
    const has = node.marks.some(
      (item) => item.type.name === "link" && String(item.attrs["href"] ?? "") === href,
    );
    if (!has) {
      inRun = false;
      return true;
    }
    if (!inRun) {
      seen += 1;
      inRun = true;
      if (seen === occurrence) {
        found = pos;
        return false;
      }
    }
    return true;
  });
  return found;
}

const UNLINKED_SKIP_NODES = new Set([
  "wiki_link",
  "code_block",
  "math_inline",
  "math_block",
  "html_inline",
  "html_block",
]);

function findNthUnlinkedText(doc: PmNode, needleRaw: string, occurrence: number): number | null {
  const needle = needleRaw.toLowerCase();
  if (needle === "") {
    return null;
  }
  let seen = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (UNLINKED_SKIP_NODES.has(node.type.name)) {
      return false;
    }
    if (!node.isText || node.text === undefined) {
      return true;
    }
    if (node.marks.some((mark) => mark.type.name === "link" || mark.type.name === "code")) {
      return false;
    }
    const lower = node.text.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at === -1) {
        break;
      }
      seen += 1;
      if (seen === occurrence) {
        found = pos + at;
        return false;
      }
      from = at + Math.max(needle.length, 1);
    }
    return true;
  });
  return found;
}
