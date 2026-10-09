/** 画布中心对应的内容比例坐标；浏览器负责将恢复后的滚动范围夹取到有效边界。 */
export type ViewportAnchor = { x: number; y: number };

/**
 * 在缩放前记录用户正在看的位置，避免倍率变化后回到内容左上角。
 * @param viewport 可滚动的预览窗口。
 * @param surface 图片或已提交的 PDF 页面。
 * @returns 中心的比例坐标；内容没有有效尺寸时返回 null。DOM 测量错误原样传播。
 */
export function captureViewportAnchor(
  viewport: HTMLElement,
  surface: HTMLElement,
): ViewportAnchor | null {
  const content = surface.getBoundingClientRect();
  if (content.width <= 0 || content.height <= 0) return null;
  const view = viewport.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        1,
        (view.left + viewport.clientLeft + viewport.clientWidth / 2 - content.left) / content.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1,
        (view.top + viewport.clientTop + viewport.clientHeight / 2 - content.top) / content.height,
      ),
    ),
  };
}

/**
 * 布局完成后把同一内容点放回画布中心；不引入平滑滚动与指针操作争抢位置。
 * @param viewport 可滚动的预览窗口。
 * @param surface 缩放后的可见内容。
 * @param anchor 缩放前捕获的比例坐标。
 * @returns 无返回值；DOM 测量错误原样传播。
 */
export function restoreViewportAnchor(
  viewport: HTMLElement,
  surface: HTMLElement,
  anchor: ViewportAnchor,
): void {
  const content = surface.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  viewport.scrollLeft +=
    content.left +
    content.width * anchor.x -
    view.left -
    viewport.clientLeft -
    viewport.clientWidth / 2;
  viewport.scrollTop +=
    content.top +
    content.height * anchor.y -
    view.top -
    viewport.clientTop -
    viewport.clientHeight / 2;
}
