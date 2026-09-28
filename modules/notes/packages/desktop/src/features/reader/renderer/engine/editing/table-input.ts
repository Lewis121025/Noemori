import { Fragment, Slice, type Node as PmNode } from "prosemirror-model";
import { Plugin, type Command, type EditorState } from "prosemirror-state";
import { serializeMarkdown } from "../markdown/serialize";

function withinCell(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return $from.sameParent($to) && ["table_header", "table_cell"].includes($from.parent.type.name);
}

/** 单元格软换行使用普通行内节点，保存时以 GFM 可往返的 <br> 表达。 */
export const tableLineBreak: Command = (state, dispatch) => {
  if (!withinCell(state)) return false;
  if (dispatch !== undefined) {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const node = state.schema.node(
      "hard_break",
      null,
      undefined,
      marks.filter((mark) => mark.type.name !== "code"),
    );
    dispatch(state.tr.replaceSelectionWith(node, false).ensureMarks(marks).scrollIntoView());
  }
  return true;
};

/**
 * 单元格只接收行内内容；多段粘贴按软换行连接，避免 ProseMirror 为适配块节点拆开表格。
 * 文字格式和行内附件保留，无法直接容纳的源码块转为可编辑的字面文本。
 */
export const tableClipboard = new Plugin({
  props: {
    transformPasted(slice, view) {
      return withinCell(view.state)
        ? new Slice(Fragment.fromArray(inlineContent(slice.content)), 0, 0)
        : slice;
    },
  },
});

function inlineContent(fragment: Fragment): PmNode[] {
  const result: PmNode[] = [];
  fragment.forEach((node, _offset, index) => {
    const schema = node.type.schema;
    if (index > 0 && (node.isBlock || fragment.child(index - 1).isBlock))
      result.push(schema.node("hard_break"));
    if (node.isText) {
      node.textContent.split(/\r\n?|\n/).forEach((line, at) => {
        if (at > 0) result.push(schema.node("hard_break"));
        if (line !== "") result.push(schema.text(line, node.marks));
      });
    } else if (node.isInline) result.push(node);
    else if (node.isLeaf || ["html_block", "markdown_block"].includes(node.type.name)) {
      const source = serializeMarkdown(schema.node("doc", null, node)).replace(/\n$/, "");
      if (source !== "") result.push(...inlineContent(Fragment.from(schema.text(source))));
    } else result.push(...inlineContent(node.content));
  });
  return result;
}
