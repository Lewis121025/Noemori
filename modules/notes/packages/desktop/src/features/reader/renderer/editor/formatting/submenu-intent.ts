/** 鼠标在菜单中的视口坐标，与原生浮层的边界使用同一坐标系。 */
export type MenuPointer = { x: number; y: number };

/**
 * 判断指针是否正在朝已展开子菜单移动，避免斜向穿过相邻项时误关闭目标。
 * @param previous 父菜单中上一处鼠标位置。
 * @param current 当前鼠标位置。
 * @param submenu 原生锚点布局后的真实边界，支持左右翻转。
 * @returns 位于通往近侧边缘的三角区域且持续靠近时返回 true；非法或空边界返回 false。
 * @throws 不抛出异常；退化几何沿用即时菜单切换。
 */
export function approachesSubmenu(
  previous: MenuPointer,
  current: MenuPointer,
  submenu: Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">,
): boolean {
  if (
    ![
      previous.x,
      previous.y,
      current.x,
      current.y,
      submenu.left,
      submenu.right,
      submenu.top,
      submenu.bottom,
    ].every(Number.isFinite) ||
    submenu.right <= submenu.left ||
    submenu.bottom <= submenu.top
  )
    return false;
  const edge =
    submenu.left >= previous.x ? submenu.left : submenu.right <= previous.x ? submenu.right : null;
  if (edge === null || edge === previous.x) return false;
  const progress = (current.x - previous.x) / (edge - previous.x);
  if (progress <= 0 || progress > 1) return false;
  // 少量边界余量容纳鼠标跨过圆角和父子菜单之间的间隙。
  const top = previous.y + (submenu.top - 4 - previous.y) * progress;
  const bottom = previous.y + (submenu.bottom + 4 - previous.y) * progress;
  return current.y >= top && current.y <= bottom;
}
