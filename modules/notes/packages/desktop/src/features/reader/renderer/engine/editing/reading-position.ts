/** 重载前的可见源码位置及像素偏移；只在一次视图替换期间持有，不保存 DOM 内容。 */
export type ReadingPosition = {
  scroller: HTMLElement;
  top: number;
  left: number;
  anchor: { position: number; offset: number } | null;
};

/**
 * 在滚动区顶部记录文字锚点，避免前文插入段落后按旧 scrollTop 跳到别处。
 * 没有可见文字或布局 API 时只记录滚动值；不移动选区或焦点。
 */
export function captureReadingPosition(
  editor: HTMLElement,
  scroller: HTMLElement,
  positionAt: (coordinates: { left: number; top: number }) => number | null,
  topAt: (position: number) => number | null,
): ReadingPosition {
  const result: ReadingPosition = {
    scroller,
    top: scroller.scrollTop,
    left: scroller.scrollLeft,
    anchor: null,
  };
  if (!editor.isConnected || typeof document.elementFromPoint !== "function") return result;
  const bounds = scroller.getBoundingClientRect();
  const content = editor.getBoundingClientRect();
  const top = Math.max(bounds.top + 8, content.top + 1);
  if (top >= Math.min(bounds.bottom, content.bottom)) return result;
  const position = positionAt({ left: Math.max(bounds.left, content.left) + 8, top });
  const at = position === null ? null : topAt(position);
  if (position !== null && at !== null) result.anchor = { position, offset: at - bounds.top };
  return result;
}

/** 按新版本位置恢复同一滚动区；滚动区已卸载时不产生迟到的页面移动。 */
export function restoreReadingPosition(
  previous: ReadingPosition,
  map: (position: number) => number,
  topAt: (position: number) => number | null,
): void {
  const { scroller, anchor } = previous;
  if (!scroller.isConnected) return;
  const top = anchor === null ? null : topAt(map(anchor.position));
  scroller.scrollTop =
    top === null || anchor === null
      ? previous.top
      : scroller.scrollTop + top - scroller.getBoundingClientRect().top - anchor.offset;
  scroller.scrollLeft = previous.left;
}
