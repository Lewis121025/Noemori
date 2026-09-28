/** 工具条定位只需要可见矩形，使用结构类型便于独立验证窗口边界。 */
type Bounds = { left: number; right: number; top: number; bottom: number };

/**
 * 将工具条放在选区上方，空间不足时翻到下方；选区离开视口时不悬挂在窗口边缘。
 * @param selection 当前文字选区的可见范围。
 * @param viewport 正文与窗口相交后的可用区域。
 * @param size 工具条的实际尺寸。
 * @returns 固定定位坐标；没有可用空间时返回 null，不遮盖正在选中的文字。
 */
export function placeSelectionToolbar(
  selection: Bounds,
  viewport: Bounds,
  size: { width: number; height: number },
): { left: number; top: number } | null {
  const gap = 8;
  if (
    selection.bottom <= viewport.top ||
    selection.top >= viewport.bottom ||
    size.width > viewport.right - viewport.left - gap * 2
  )
    return null;
  const above = selection.top - size.height - gap;
  const below = selection.bottom + gap;
  const top = above >= viewport.top + gap ? above : below;
  if (top < viewport.top + gap || top + size.height > viewport.bottom - gap) return null;
  return {
    left: Math.max(
      viewport.left + gap,
      Math.min(
        (selection.left + selection.right - size.width) / 2,
        viewport.right - size.width - gap,
      ),
    ),
    top,
  };
}
