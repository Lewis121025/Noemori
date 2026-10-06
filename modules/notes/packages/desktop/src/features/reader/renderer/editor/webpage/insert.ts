import { closeHistory } from "prosemirror-history";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { canUseEditingTools } from "../read-only";
import { parseWebPage, type WebPage } from "../../../shared/webpage";

/**
 * 网页是块级内容；代码、表格和跨段选区没有无损的块插入位置。
 * @param state 所属编辑器当前状态。
 * @returns 是否能在保留当前结构的前提下插入网页。
 */
export function canInsertWebPage(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  if (
    !canUseEditingTools(state) ||
    !$from.sameParent($to) ||
    !$from.parent.inlineContent ||
    $from.parent.type.spec.code
  )
    return false;
  for (let depth = $from.depth; depth > 0; depth--)
    if ($from.node(depth).type.name === "table") return false;
  return true;
}

/**
 * 把校验后的网页配置作为一个可撤销事务插入，不获取或保存网站内容。
 * @param value 用户填写的地址和高度。
 * @returns 遵循 ProseMirror 门禁的插入命令；不可插入时返回 false。
 * @throws 配置无效时抛出中文错误，调用方保留输入供修正。
 */
export function insertWebPage(value: WebPage): Command {
  const page = parseWebPage(value);
  return (state, dispatch) => {
    if (!canInsertWebPage(state)) return false;
    if (dispatch) {
      const tr = closeHistory(state.tr).replaceRangeWith(
        state.selection.from,
        state.selection.to,
        state.schema.node("webpage", page),
      );
      if (tr.doc.lastChild?.type.name === "webpage")
        tr.insert(tr.doc.content.size, state.schema.node("paragraph"));
      tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(state.selection.to, 1))));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
