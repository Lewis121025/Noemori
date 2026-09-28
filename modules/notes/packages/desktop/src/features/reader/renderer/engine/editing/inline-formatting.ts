import type { EditorState } from "prosemirror-state";

const markNames = ["strong", "em", "strike", "highlight", "code"] as const;

/** 行内格式的选区状态；mixed 表示可格式化内容中仅有一部分带该样式。 */
export type InlineMarkStates = Record<(typeof markNames)[number], boolean | "mixed">;

/**
 * 一次遍历读取全部文字样式，避免每个按钮单独扫描长选区。
 * @param state 当前编辑器状态；光标处优先使用待输入样式。
 * @returns 全部应用、部分应用或未应用的状态；无可格式化内容时为 false，不抛出异常。
 */
export function readInlineMarkStates(state: EditorState): InlineMarkStates {
  const result: InlineMarkStates = {
    strong: false,
    em: false,
    strike: false,
    highlight: false,
    code: false,
  };
  const { empty, $from, ranges } = state.selection;
  if (empty) {
    for (const name of markNames) {
      const type = state.schema.marks[name];
      result[name] = !!type?.isInSet(state.storedMarks ?? $from.marks());
    }
    return result;
  }
  const present = new Set<string>();
  const missing = new Set<string>();
  for (const range of ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos, parent) => {
      if (!node.isInline || !parent) return;
      // toggleMark 不要求选区边缘的空白携带样式，按钮状态须遵循同一语义。
      const whitespace =
        node.isText &&
        /^\s*$/.test(
          node.textBetween(
            Math.max(0, range.$from.pos - pos),
            Math.min(node.nodeSize, range.$to.pos - pos),
          ),
        );
      for (const name of markNames) {
        const type = state.schema.marks[name];
        if (!type || !parent.type.allowsMarkType(type)) continue;
        if (type.isInSet(node.marks)) present.add(name);
        else if (!whitespace) missing.add(name);
      }
    });
  }
  for (const name of markNames)
    result[name] = present.has(name) ? (missing.has(name) ? "mixed" : true) : false;
  return result;
}
