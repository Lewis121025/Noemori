/**
 * 从完整目录行中选出需要挂载的索引，滚动缓冲不改变搜索和键盘导航的数据范围。
 * @param count 完整行数，必须为非负整数。
 * @param scrollTop 当前滚动位置；列表缩短时按新的内容高度夹取。
 * @param viewportHeight 视口像素高度，尚未测量或侧栏隐藏时可以为零。
 * @param rowHeight 含行间距的正数像素高度，由界面测量。
 * @param retained 焦点和拖拽源的索引；有效条目在视口外仍保持挂载。
 * @returns 按原顺序排列的不重复索引；小目录完整挂载，空目录返回空数组。
 */
export function fileTreeWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  retained: readonly number[],
): number[] {
  if (count <= 100) return Array.from({ length: count }, (_, index) => index);
  const height = Math.max(rowHeight, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, count * rowHeight - height));
  const first = Math.max(0, Math.floor(top / rowHeight) - 8);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + 8);
  const indices = new Set(Array.from({ length: last - first }, (_, offset) => first + offset));
  for (const index of retained) if (index >= 0 && index < count) indices.add(index);
  return [...indices].sort((left, right) => left - right);
}
