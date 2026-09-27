/**
 * 补全候选的提交事务构造。
 *
 * wiki 语法插入 `wiki_link` 原子节点（连已输入的 `[[` 触发串一起替换）；
 * md 语法把已输入的 `[标签](查询` 整体转换为带链接标记的文本。
 * 纯文本插入在保存时会被序列化器转义成字面括号（`\[\[`），
 * 必须落成文档模型的真实链接结构——这是保真契约的一部分。
 * 光标后已有闭合语法时一并消费，避免残留字面 `]]`/`)`。
 */

import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { documentSchema } from "../../markdown/schema";
import type { SuggestRequest } from "./context";

/**
 * 构造把候选写入文档的事务（含光标落位与滚动）。
 *
 * @param state 当前编辑器状态；空光标位置即替换终点。
 * @param request 触发上下文。
 * @param value 候选插入文本（去扩展名的路径、标题原文或 `^块ID`）。
 * @param alias 别名候选的显示名；wiki 写成 `[[目标|别名]]`，md 作为空标签的链接文字。
 * @returns 可直接 dispatch 的事务；范围失效（光标已离开、越界）返回 `null`，
 * 调用方关闭弹层即可，不得强行写入。
 */
export function suggestInsertion(
  state: EditorState,
  request: SuggestRequest,
  value: string,
  alias: string | null = null,
): Transaction | null {
  const to = state.selection.from;
  if (!state.selection.empty || request.from > to) return null;
  const end = to + (request.closeAfter ? (request.syntax === "wiki" ? 2 : 1) : 0);
  if (end > state.doc.content.size) return null;
  const anchored = request.kind === "heading" || request.kind === "block";
  if (request.syntax === "wiki") {
    const target = anchored ? `${request.target}#${value}` : value;
    const atom = documentSchema.node("wiki_link", { target, alias });
    const from = request.triggerFrom;
    const tr = state.tr.replaceWith(from, end, atom);
    return tr.setSelection(TextSelection.create(tr.doc, from + atom.nodeSize)).scrollIntoView();
  }
  const href = anchored ? `${request.target}#${value}` : value;
  if (request.labelStart === null) {
    // 找不到配对标签括号：退回文本插入，与用户继续手敲的语义一致。
    const insert = `${value}${request.closeAfter ? "" : ")"}`;
    const tr = state.tr.replaceWith(request.from, end, state.schema.text(insert));
    return tr
      .setSelection(TextSelection.create(tr.doc, request.from + insert.length))
      .scrollIntoView();
  }
  // 块查询的 from 在 `#^` 之后，标签终点仍在 `](` 之前。
  const labelEnd = request.triggerFrom;
  const label = state.doc.textBetween(request.labelStart + 1, labelEnd);
  const text = label === "" ? (alias ?? value) : label;
  const marks = (state.storedMarks ?? state.selection.$from.marks()).filter(
    (mark) => mark.type.name !== "link",
  );
  const linkMark = documentSchema.mark("link", { href, reference: null });
  const tr = state.tr.replaceWith(
    request.labelStart,
    end,
    documentSchema.text(text, [...marks, linkMark]),
  );
  return tr
    .setSelection(TextSelection.create(tr.doc, request.labelStart + text.length))
    .scrollIntoView();
}
