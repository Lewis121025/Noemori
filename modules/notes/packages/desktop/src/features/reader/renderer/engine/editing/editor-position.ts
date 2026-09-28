import { TextSelection } from "prosemirror-state";
import type { EditorView as MarkdownView } from "prosemirror-view";
import { EditorSelection } from "@codemirror/state";
import type { EditorView as CodeView } from "@codemirror/view";
import type { ReadingBookmark } from "../../../shared/reading-position";
import { captureSourcePoint, resolveSourcePoint } from "../document/source-point";
import { codeIndexToSourceOffset, sourceOffsetToCodeIndex } from "../document/source-offset";
import type { createMarkdownSession, EditorSnapshot } from "../markdown/source-session";
import { MarkdownSnapshotError } from "../markdown/session-recovery";
import { captureReadingPosition } from "./reading-position";

/** 阅读锚点可持久化；选区只随同一份源码交接，保留方向但不跨版本盲用。 */
export type EditorPosition = {
  reading: ReadingBookmark | null;
  selection: { anchor: number; head: number } | null;
};

/** 两种编辑器共用的位置契约；恢复不改正文，异步布局前须核对本次导航仍有效。 */
export type EditorPositionApi = {
  /** 捕获当前源码位置；无法保真表示的恢复草稿返回 null，其他异常继续抛出。 */
  capturePosition: () => EditorPosition | null;
  /** 等待布局后恢复可见内容；isCurrent 为 false 时取消后续选区和滚动写入。 */
  restorePosition: (position: EditorPosition, isCurrent: () => boolean) => Promise<void>;
};

const decode = (snapshot: EditorSnapshot) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(snapshot.bytes);
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function captureViewport(
  element: HTMLElement,
  source: string,
  sourceAt: (position: number) => number,
  positionAt: (coordinates: { left: number; top: number }) => number | null,
  topAt: (position: number) => number | null,
): ReadingBookmark | null {
  const scroller = element.closest(".main");
  if (!(scroller instanceof HTMLElement)) return null;
  // 文首是稳定的边界，不应因属性栏、字体或标题样式变化而向下漂移。
  if (scroller.scrollTop === 0) return { source: captureSourcePoint(source, 0), inset: 0 };
  const { anchor } = captureReadingPosition(element, scroller, positionAt, topAt);
  return anchor === null
    ? null
    : {
        source: captureSourcePoint(source, sourceAt(anchor.position)),
        inset: anchor.offset,
      };
}

function restoreViewport(
  element: HTMLElement,
  reading: ReadingBookmark,
  topAt: () => number | null,
): void {
  const scroller = element.closest(".main");
  if (!(scroller instanceof HTMLElement) || !scroller.isConnected) return;
  if (reading.source.offset === 0 && reading.inset === 0) scroller.scrollTop = 0;
  else {
    const top = topAt();
    if (top === null) return;
    const inset = Math.max(
      -scroller.clientHeight,
      Math.min(scroller.clientHeight - 24, reading.inset),
    );
    scroller.scrollTop += top - scroller.getBoundingClientRect().top - inset;
  }
}

/** 为排版与阅读表面提供源码位置；所有位置都基于最新保真快照，不写文件。 */
export function markdownPosition(
  view: MarkdownView,
  session: ReturnType<typeof createMarkdownSession>,
): EditorPositionApi {
  return {
    capturePosition() {
      let source: string;
      try {
        source = decode(session.snapshot(view.state.doc));
      } catch (error) {
        // 无法表达为源码的草稿没有合法源码锚点；正文恢复仍由保存链路负责。
        if (error instanceof MarkdownSnapshotError) return null;
        throw error;
      }
      return {
        reading: captureViewport(
          view.dom,
          source,
          session.sourceOffsetAt,
          (at) => view.posAtCoords(at)?.pos ?? null,
          (pos) => view.coordsAtPos(pos).top,
        ),
        selection: {
          anchor: session.sourceOffsetAt(view.state.selection.anchor),
          head: session.sourceOffsetAt(view.state.selection.head),
        },
      };
    },
    async restorePosition(position, isCurrent) {
      if (view.isDestroyed || !isCurrent()) return;
      const source = decode(session.snapshot(view.state.doc));
      const at = (offset: number) =>
        session.positionAt(Math.min(source.length, Math.max(0, offset)));
      if (position.selection !== null) {
        const { anchor, head } = position.selection;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.between(
              view.state.doc.resolve(at(anchor)),
              view.state.doc.resolve(at(head)),
            ),
          ),
        );
      }
      await nextFrame();
      if (view.isDestroyed || !isCurrent() || position.reading === null) return;
      const anchor = at(resolveSourcePoint(source, position.reading.source));
      restoreViewport(view.dom, position.reading, () => view.coordsAtPos(anchor).top);
    },
  };
}

/** 为源码表面提供原始换行下的位置；虚拟化尚未渲染的目标先按行定位，再按字符校正。 */
export function codePosition(view: CodeView, snapshot: () => EditorSnapshot): EditorPositionApi {
  return {
    capturePosition() {
      const source = decode(snapshot());
      const sourceAt = (pos: number) => codeIndexToSourceOffset(source, pos);
      return {
        reading: captureViewport(
          view.contentDOM,
          source,
          sourceAt,
          // 虚拟行或 inert 期间原生坐标命中可能缺席；行布局仍属于当前文档，可作为可靠锚点。
          (at) =>
            view.posAtCoords({ x: at.left, y: at.top }, false) ??
            view.lineBlockAtHeight(Math.max(0, at.top - view.documentTop)).from,
          (pos) => view.coordsAtPos(pos)?.top ?? view.documentTop + view.lineBlockAt(pos).top,
        ),
        selection: {
          anchor: sourceAt(view.state.selection.main.anchor),
          head: sourceAt(view.state.selection.main.head),
        },
      };
    },
    async restorePosition(position, isCurrent) {
      if (!view.dom.isConnected || !isCurrent()) return;
      const source = decode(snapshot());
      const at = (offset: number) => sourceOffsetToCodeIndex(source, offset);
      if (position.selection !== null)
        view.dispatch({
          selection: EditorSelection.single(
            at(position.selection.anchor),
            at(position.selection.head),
          ),
        });
      await nextFrame();
      const reading = position.reading;
      if (!view.dom.isConnected || !isCurrent() || reading === null) return;
      const anchor = at(resolveSourcePoint(source, reading.source));
      restoreViewport(
        view.dom,
        reading,
        () => view.coordsAtPos(anchor)?.top ?? view.documentTop + view.lineBlockAt(anchor).top,
      );
      const scroller = view.dom.closest(".main");
      const top = scroller?.scrollTop;
      await nextFrame();
      if (!view.dom.isConnected || !isCurrent() || scroller?.scrollTop !== top) return;
      restoreViewport(view.dom, reading, () => view.coordsAtPos(anchor)?.top ?? null);
    },
  };
}
