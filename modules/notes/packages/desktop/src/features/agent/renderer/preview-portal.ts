/**
 * 把同一预览节点移入放大对话框，保留源码选择、滚动和媒体状态。
 * @param node 要移动的预览根节点。
 * @param destination 放大容器；null 表示返回初始宿主。
 * @returns Svelte action 生命周期，卸载时移除已移出的节点。
 * @throws 无法操作 DOM 时保留原始异常。
 */
export function previewPortal(node: HTMLDivElement, destination: HTMLDialogElement | null) {
  const parent = node.parentElement;
  const move = (target: HTMLDialogElement | null) => {
    const container = target ?? parent;
    // 原子移动保留 iframe 的浏览上下文；普通 append 会重新加载页面并丢失滚动位置。
    if (container && node.parentElement !== container) container.moveBefore(node, null);
  };
  move(destination);
  return { update: move, destroy: () => node.remove() };
}
