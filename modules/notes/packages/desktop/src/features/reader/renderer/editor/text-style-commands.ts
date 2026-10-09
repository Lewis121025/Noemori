import { toggleMark } from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import { documentSchema } from "../../shared/markdown/schema";
import type { TextColor, HighlightColor } from "../../shared/markdown/text-style";
import { editingCommand } from "./read-only";

const styleNames = [
  "strong",
  "em",
  "strike",
  "underline",
  "highlight",
  "text_color",
  "code",
] as const;

function colorCommand(
  name: "text_color" | "highlight",
  color: TextColor | HighlightColor | null,
): Command {
  const type = documentSchema.marks[name]!;
  return editingCommand((state, dispatch) => {
    if (!toggleMark(type)(state)) return false;
    if (dispatch) {
      const tr = state.tr;
      const mark = color === null ? null : type.create({ color });
      if (state.selection.empty) {
        if (mark) tr.addStoredMark(mark);
        else tr.removeStoredMark(type);
      } else {
        for (const range of state.selection.ranges) {
          if (mark) {
            // 与快捷键样式命令一致，边缘空白不着色，黄色高亮才能无损使用双等号保存。
            const start = range.$from.nodeAfter;
            const end = range.$to.nodeBefore;
            const leading = start?.isText ? (/^\s*/.exec(start.text ?? "")?.[0].length ?? 0) : 0;
            const trailing = end?.isText ? (/\s*$/.exec(end.text ?? "")?.[0].length ?? 0) : 0;
            const from = range.$from.pos + leading;
            const to = range.$to.pos - trailing;
            if (from < to) tr.addMark(from, to, mark);
          } else tr.removeMark(range.$from.pos, range.$to.pos, type);
        }
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  });
}

/**
 * 应用指定文字色或恢复默认色；保留选区与链接，写入权限由编辑器统一验证。
 * @param color 调色板颜色；null 移除文字色，不影响其他格式。
 * @returns 文档命令；无法格式化时返回 false，模型异常继续抛出。
 */
export function setTextColor(color: TextColor | null): Command {
  return colorCommand("text_color", color);
}

/**
 * 光标处改变下一次输入的高亮，选区内统一应用并保留边缘空白。
 * @param color 调色板背景色；null 取消高亮。
 * @returns 文档命令；无法格式化时返回 false，模型异常继续抛出。
 */
export function setHighlightColor(color: HighlightColor | null): Command {
  return colorCommand("highlight", color);
}

/** 清除视觉文字样式；文字、链接及公式等节点语义保留，空光标仅清理待输入样式。 */
export const clearTextStyles: Command = editingCommand((state, dispatch) => {
  const types = styleNames.map((name) => state.schema.marks[name]!);
  let present =
    state.selection.empty &&
    types.some((type) => type.isInSet(state.storedMarks ?? state.selection.$from.marks()));
  if (!state.selection.empty)
    for (const range of state.selection.ranges)
      state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
        if (node.isInline && types.some((type) => type.isInSet(node.marks))) present = true;
      });
  if (!present) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const type of types) {
      if (state.selection.empty) tr.removeStoredMark(type);
      else
        for (const range of state.selection.ranges)
          tr.removeMark(range.$from.pos, range.$to.pos, type);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
});
