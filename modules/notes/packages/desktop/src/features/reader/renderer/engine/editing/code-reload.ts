import { Text, type EditorState } from "@codemirror/state";
import {
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { textReloadChanges } from "./reload-mapping";
import {
  captureReadingPosition,
  restoreReadingPosition,
  type ReadingPosition,
} from "./reading-position";

/** 普通文本重载的瞬时上下文；选区、查询和焦点均来自现有编辑器状态。 */
export type CodeReloadContext = {
  state: EditorState;
  focused: boolean;
  externalFocus: HTMLElement | null;
  reading: ReadingPosition[];
  input: {
    name: string;
    value: string;
    from: number;
    to: number;
    direction: "forward" | "backward" | "none";
  } | null;
};

/** 重载前记录文本与搜索表面的选区，区分 CodeMirror 内部滚动和工作区滚动。 */
export function captureCodeReload(view: EditorView): CodeReloadContext {
  const scrollers = [view.scrollDOM];
  const main = view.dom.closest(".main");
  if (main instanceof HTMLElement) scrollers.push(main);
  const active = view.dom.ownerDocument.activeElement;
  return {
    state: view.state,
    focused: view.hasFocus,
    externalFocus: active instanceof HTMLElement && !view.dom.contains(active) ? active : null,
    reading: scrollers.map((scroller) =>
      captureReadingPosition(
        view.contentDOM,
        scroller,
        (at) => view.posAtCoords({ x: at.left, y: at.top }),
        (pos) => view.coordsAtPos(pos)?.top ?? null,
      ),
    ),
    input:
      active instanceof HTMLInputElement && view.dom.contains(active)
        ? {
            name: active.name,
            value: active.value,
            from: active.selectionStart ?? 0,
            to: active.selectionEnd ?? 0,
            direction: active.selectionDirection ?? "none",
          }
        : null,
  };
}

/** 用真实文本差异恢复选区；CRLF 仅在编辑器中规范化，保存仍使用外部原始源码。 */
export function prepareCodeReload(previous: CodeReloadContext, source: string) {
  const doc = Text.of(source.split(/\r\n?|\n/));
  const changes = textReloadChanges(previous.state.doc.toString(), doc.toString());
  return {
    doc,
    selection: previous.state.selection.map(changes),
    restore(view: EditorView): void {
      if (searchPanelOpen(previous.state)) {
        const stored = getSearchQuery(previous.state);
        const live = previous.input;
        // 查找面板在按键抬起时才写入状态。重载若发生在输入之后、提交之前，必须以输入框里的文字为准。
        const query =
          live?.name === "search" || live?.name === "replace"
            ? new SearchQuery({
                search: live.name === "search" ? live.value : stored.search,
                replace: live.name === "replace" ? live.value : stored.replace,
                caseSensitive: stored.caseSensitive,
                literal: stored.literal,
                regexp: stored.regexp,
                wholeWord: stored.wholeWord,
              })
            : stored;
        // 打开面板会用当前正文选区生成默认查询；必须在其后写回原查询。
        openSearchPanel(view);
        view.dispatch({ effects: setSearchQuery.of(query) });
      }
      if (previous.focused) view.focus();
      else if (previous.externalFocus?.isConnected)
        previous.externalFocus.focus({ preventScroll: true });
      else if (previous.input !== null) {
        const input = Array.from(view.dom.querySelectorAll("input")).find(
          (item) => item.name === previous.input?.name,
        );
        if (input !== undefined) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(previous.input.from, previous.input.to, previous.input.direction);
        }
      }
      const reading = previous.reading.map((position, index) =>
        index === 0 ? { ...position, scroller: view.scrollDOM } : position,
      );
      // CodeMirror 布局按帧测量；请求随所属视图销毁，不向已卸载的滚动区写入。
      view.requestMeasure({
        read: () =>
          reading.map((position) => ({
            position,
            top:
              position.anchor === null
                ? null
                : (view.coordsAtPos(changes.mapPos(position.anchor.position))?.top ?? null),
          })),
        write: (measured) => {
          for (const { position, top } of measured)
            restoreReadingPosition(
              position,
              (pos) => changes.mapPos(pos),
              () => top,
            );
        },
      });
    },
  };
}
