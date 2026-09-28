import { NodeSelection, type EditorState } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { linkSelectionKey } from "../links/link-editing";
import { markdownReloadMapping, textReloadChanges } from "./reload-mapping";
import { focusDocument } from "../read-only";
import {
  captureReadingPosition,
  restoreReadingPosition,
  type ReadingPosition,
} from "../reading-position";

/** 同一路径重载前的临时上下文；新视图接管后立即释放旧状态，不形成第二份可变文档。 */
export type MarkdownReloadContext = {
  state: EditorState;
  focused: boolean;
  reading: ReadingPosition | null;
  source: {
    value: string;
    from: number;
    to: number;
    direction: "forward" | "backward" | "none";
  } | null;
};

/** 在旧 DOM 仍存在时记录选区、正文焦点、源码光标与阅读位置，不序列化或修改文档。 */
export function captureMarkdownReload(view: EditorView): MarkdownReloadContext {
  const active = view.dom.ownerDocument.activeElement;
  const source =
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    view.dom.contains(active)
      ? {
          value: active.value,
          from: active.selectionStart ?? 0,
          to: active.selectionEnd ?? 0,
          direction: active.selectionDirection ?? "none",
        }
      : null;
  const scroller = view.dom.closest(".main");
  return {
    state: view.state,
    focused: view.hasFocus(),
    source,
    reading:
      scroller instanceof HTMLElement
        ? captureReadingPosition(
            view.dom,
            scroller,
            (at) => view.posAtCoords(at)?.pos ?? null,
            (pos) => view.coordsAtPos(pos).top,
          )
        : null,
  };
}

/**
 * 为新磁盘版本准备合法选区与弹窗书签；重载本身不成为用户的撤销步骤。
 * 恢复只操作新视图，销毁时返回的清理函数取消尚未执行的布局校正。
 */
export function prepareMarkdownReload(previous: MarkdownReloadContext, doc: PmNode) {
  const mapping = markdownReloadMapping(previous.state.doc, doc);
  const selection = previous.state.selection.map(doc, mapping);
  const bookmark = linkSelectionKey.getState(previous.state)?.map(mapping) ?? null;
  const sourceEditing =
    previous.source !== null &&
    selection instanceof NodeSelection &&
    previous.state.selection instanceof NodeSelection &&
    selection.node.type === previous.state.selection.node.type;
  return {
    selection,
    bookmark,
    sourceEditing,
    restore(view: EditorView): () => void {
      let disposed = false;
      if (previous.focused) focusDocument(view);
      queueMicrotask(() => {
        if (disposed || !sourceEditing || previous.source === null) return;
        const field = view.dom.querySelector(".math-source, .html-source");
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
        const changes = textReloadChanges(previous.source.value, field.value);
        field.focus({ preventScroll: true });
        field.setSelectionRange(
          changes.mapPos(previous.source.from),
          changes.mapPos(previous.source.to),
          previous.source.direction,
        );
      });
      const reading = previous.reading;
      const restore = () => {
        if (reading !== null)
          restoreReadingPosition(
            reading,
            (position) => mapping.map(position),
            (position) => view.coordsAtPos(position).top,
          );
      };
      restore();
      const top = reading?.scroller.scrollTop;
      const frame = requestAnimationFrame(() => {
        // 用户已滚动时不再校正；本轮排版完成后的恢复不能覆盖新的阅读意图。
        if (reading?.scroller.scrollTop === top) restore();
      });
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
      };
    },
  };
}
