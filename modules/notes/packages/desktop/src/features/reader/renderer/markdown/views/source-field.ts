/** 公式与 HTML 源码输入共享同一条文档提交路径，保存无需等待失焦。 */
import type { EditorView } from "prosemirror-view";
import { Selection } from "prosemirror-state";
import { sourceEditingKey } from "../../editor/source/source-editing";
import { createCompositionGuard, isCompositionKey } from "../../../shared/composition";
import { applyMarkdownHistory } from "../../editor/history";

/** 源码节点保存原文的 schema 属性。 */
export type SourceAttribute = "tex" | "html" | "source";

/**
 * 将输入实时写入文档，同时把保存快捷键交回编辑器。
 *
 * @param field 当前节点的源码输入框；移除后监听器随元素一起释放。
 * @param view 所属编辑器，事务触发既有脏标记与自动保存。
 * @param getPos 节点当前位置，不能缓存初始位置。
 * @param attribute 要更新的源码属性。
 * @returns 无返回值；输入值留在同一 DOM 节点内，避免打断输入法与光标。
 */
export function bindSourceField(
  field: HTMLInputElement | HTMLTextAreaElement,
  view: EditorView,
  getPos: () => number | undefined,
  attribute: SourceAttribute,
): void {
  const composition = createCompositionGuard();
  // 监听仅挂在该输入框上，源码节点移除后随 DOM 一起释放。
  composition.bind(field);
  field.addEventListener("beforeinput", (event) => {
    if (!(event instanceof InputEvent)) return;
    const action =
      event.inputType === "historyUndo"
        ? "undo"
        : event.inputType === "historyRedo"
          ? "redo"
          : null;
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!composition.active) applyMarkdownHistory(view, action);
  });
  field.addEventListener("input", () => {
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    if (node === null || node.attrs[attribute] === field.value) return;
    // 只更新属性；替换整个行内节点会映射掉 NodeSelection，导致输入框失焦。
    view.dispatch(view.state.tr.setNodeAttribute(pos, attribute, field.value));
  });
  field.onkeydown = (event) => {
    if (composition.active || isCompositionKey(event)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && ["s", "z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      view.someProp("handleKeyDown", (handle) => handle(view, event));
      return;
    }
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    if (node === null) return;
    const collapsed = field.selectionStart === field.selectionEnd;
    const before =
      !modifier &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "ArrowLeft" &&
      collapsed &&
      field.selectionStart === 0;
    const after =
      !modifier &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "ArrowRight" &&
      collapsed &&
      field.selectionEnd === field.value.length;
    const finish =
      event.key === "Enter" &&
      !event.altKey &&
      !event.shiftKey &&
      (field instanceof HTMLInputElement || modifier);
    if (event.key !== "Escape" && !before && !after && !finish) return;
    event.preventDefault();
    event.stopPropagation();
    const tr = view.state.tr.setMeta(sourceEditingKey, false);
    if (finish && node.isBlock) {
      const end = tr.doc.resolve(pos + node.nodeSize);
      const paragraph = view.state.schema.nodes["paragraph"];
      // 完成块级源码后必须有可继续输入的位置；普通 Esc 不改变文档结构。
      if (
        paragraph &&
        !end.nodeAfter?.isTextblock &&
        end.parent.canReplaceWith(end.index(), end.index(), paragraph)
      )
        tr.insert(end.pos, paragraph.create());
    }
    if (before || after || finish)
      tr.setSelection(
        Selection.near(tr.doc.resolve(before ? pos : pos + node.nodeSize), before ? -1 : 1),
      );
    view.dispatch(tr);
    view.focus();
  };
}
