import type { EditorState } from "prosemirror-state";
import {
  isTextColor,
  isHighlightColor,
  type TextColor,
  type HighlightColor,
} from "../../../shared/markdown/text-style";

const markNames = ["strong", "em", "underline", "strike", "highlight", "code"] as const;

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
    underline: false,
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

/** 选区的统一文字色和高亮色；mixed 表示存在多种颜色或仅部分内容着色。 */
export type InlineColors = {
  text: TextColor | "mixed" | null;
  highlight: HighlightColor | "mixed" | null;
};

/** 一次读取两个配色状态；光标优先读取待输入样式，边缘空白不影响菜单勾选。 */
export function readInlineColors(state: EditorState): InlineColors {
  const text = new Set<TextColor | null>();
  const highlight = new Set<HighlightColor | null>();
  const add = (marks: typeof state.storedMarks): void => {
    const foreground: unknown = marks?.find((mark) => mark.type.name === "text_color")?.attrs[
      "color"
    ];
    const background: unknown = marks?.find((mark) => mark.type.name === "highlight")?.attrs[
      "color"
    ];
    text.add(isTextColor(foreground) ? foreground : null);
    highlight.add(isHighlightColor(background) ? background : null);
  };
  if (state.selection.empty) add(state.storedMarks ?? state.selection.$from.marks());
  else
    for (const range of state.selection.ranges)
      state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos, parent) => {
        if (!node.isInline || !parent?.type.allowsMarkType(state.schema.marks["highlight"]!))
          return;
        if (
          node.isText &&
          /^\s*$/.test(
            node.textBetween(
              Math.max(0, range.$from.pos - pos),
              Math.min(node.nodeSize, range.$to.pos - pos),
            ),
          )
        )
          return;
        add(node.marks);
      });
  return {
    text: text.size > 1 ? "mixed" : (text.values().next().value ?? null),
    highlight: highlight.size > 1 ? "mixed" : (highlight.values().next().value ?? null),
  };
}
