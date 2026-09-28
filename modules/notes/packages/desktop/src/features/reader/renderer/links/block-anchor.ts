/**
 * 块引用定位与嵌入切片。
 *
 * 块标识写在块末尾（`文字 ^id`），或单独成段指向前一块（`^id`）。
 * 标识只接受字母、数字和连字符，避免把普通 `^` 文本当成引用。
 */

import type { Node as PmNode } from "prosemirror-model";
import { documentSchema } from "../markdown/schema";
import { findHeadingPmPos } from "./heading-anchor";

/**
 * 找到块标识对应的块起点。
 *
 * @param doc 当前文档。
 * @param id `^` 之后的标识。
 * @returns 块节点起点；没有匹配时为 `null`。
 */
export function findBlockPmPos(doc: PmNode, id: string): number | null {
  if (!/^[A-Za-z0-9-]+$/u.test(id)) return null;
  const mark = `^${id}`;
  let found: number | null = null;
  let previous: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent.trim();
    if (text === mark) {
      if (previous !== null) found = previous;
      return false;
    }
    if (text.endsWith(` ${mark}`) || text.endsWith(`\t${mark}`)) {
      found = pos;
      return false;
    }
    previous = pos;
    return false;
  });
  return found;
}

/**
 * 按锚点切出嵌入要显示的文档。
 *
 * 无锚点返回全文。标题锚点取该标题在其父节点里的后续兄弟，直到同级或更高级标题。
 * `^id` 只取那一块。找不到时返回 `null`。
 *
 * @param doc 目标笔记解析后的文档。
 * @param anchor 锚点原文；无锚点为 `null`。
 * @returns 可独立渲染的文档；锚点失效时为 `null`。
 */
export function sliceEmbed(doc: PmNode, anchor: string | null): PmNode | null {
  if (anchor === null || anchor === "") return doc;
  if (anchor.startsWith("^")) {
    const pos = findBlockPmPos(doc, anchor.slice(1));
    if (pos === null) return null;
    const node = doc.nodeAt(pos);
    return node === null ? null : documentSchema.node("doc", null, [node]);
  }
  const start = findHeadingPmPos(doc, anchor);
  return start === null ? null : sliceHeadingSection(doc, start);
}

/** 从标题位置切出它所在父节点里的一节，引用里的标题也同样适用。 */
function sliceHeadingSection(doc: PmNode, start: number): PmNode | null {
  const at = doc.resolve(start);
  const parent = at.parent;
  const index = at.index();
  const heading = parent.child(index);
  if (heading.type.name !== "heading") return null;
  const level = heading.attrs["level"] as number;
  const blocks: PmNode[] = [heading];
  for (let next = index + 1; next < parent.childCount; next += 1) {
    const child = parent.child(next);
    if (child.type.name === "heading" && (child.attrs["level"] as number) <= level) break;
    blocks.push(child);
  }
  return documentSchema.node("doc", null, blocks);
}
