import { redo, undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { HistoryAction } from "../../shared/api";

/**
 * 判断焦点是否属于编辑器外的原生文本控件；这些输入框的历史不能改变正文。
 * @param content 编辑器实际输入区域，包含就地源码，但不包含查找等辅助控件。
 * @returns 当前焦点属于外部文本控件时为 true，否则由当前文档接管历史。
 */
export function nativeInputOwnsHistory(content: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    !content.contains(active) &&
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.isContentEditable)
  );
}

/**
 * 菜单和源码原生历史事件统一进入 ProseMirror；没有可撤销内容也不回退到浏览器历史。
 * @param view 当前文档的编辑器视图；组词中或已销毁时只消费命令。
 * @param action 撤销或重做，不改变历史分组规则。
 * @returns false 仅表示当前焦点属于其他文本控件，应由该控件处理。
 */
export function applyMarkdownHistory(view: EditorView, action: HistoryAction): boolean {
  if (nativeInputOwnsHistory(view.dom)) return false;
  if (view.isDestroyed || view.composing || !view.editable) return true;
  const active = document.activeElement;
  const hadFocus = active !== null && view.dom.contains(active);
  (action === "undo" ? undo : redo)(view.state, view.dispatch);
  // 撤销可能移除正在编辑的源码节点；仍留在输入区域，避免焦点落到 body 后无法继续写作。
  if (hadFocus && active !== null && !active.isConnected) view.focus();
  return true;
}
