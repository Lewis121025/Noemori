/**
 * 标题锚点匹配与定位。
 *
 * 锚点按标题原文匹配（Obsidian 惯例）：大小写不敏感，首尾与连续空白归一；
 * 同名标题取文档顺序的第一个。归一化规则在大纲、编辑器定位与索引校验
 * 三处共用，避免一侧验证过的锚点在另一侧找不到。
 *
 * 已知边界：标题里含 wiki 链接或行内公式时，编辑器按渲染文本（别名/公式
 * 源码）匹配，而内核索引按 mdast 原文（`[[目标]]` 字面）入库，两种表示对
 * 此类标题不一致；跳转以编辑器为准，索引仅用于补全候选。
 */

import type { Node as PmNode } from "prosemirror-model";
import { headingText } from "./outline";

/** 锚点与标题文本的归一化：连续空白折叠、去首尾、小写。 */
export function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * 在文档里找锚点对应的第一个标题。
 *
 * 标题文本按大纲同一规则提取：wiki 链接取别名（无别名取目标），
 * 行内公式取 TeX 源码，其余取文本内容。
 *
 * @param doc 当前 ProseMirror 文档。
 * @param anchor 锚点原文（`#` 之后的部分）。
 * @returns 标题节点起点；没有匹配标题时为 `null`。
 */
export function findHeadingPmPos(doc: PmNode, anchor: string): number | null {
  const target = normalizeHeadingText(anchor);
  if (target === "") {
    return null;
  }
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (node.type.name !== "heading") {
      return true;
    }
    if (normalizeHeadingText(headingText(node)) === target) {
      found = pos;
    }
    // 标题里不会嵌套标题，不必深入。
    return false;
  });
  return found;
}
