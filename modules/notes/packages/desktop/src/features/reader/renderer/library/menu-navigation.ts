/**
 * 为原生弹层补齐方向键导航；跳过禁用项，保留浏览器的 Esc 关闭与焦点恢复。
 * @param element 已包含操作按钮的弹层节点。
 * @returns 卸载时移除监听器；不改变菜单动作与打开方式，不抛出业务异常。
 */
export function menuNavigation(element: HTMLElement): { destroy: () => void } {
  const buttons = () =>
    Array.from(element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = buttons();
    if (!items.length) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.findIndex((item) => item === document.activeElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : current < 0
            ? event.key === "ArrowDown"
              ? 0
              : items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  };
  const toggle = (event: Event) => {
    // toggle 延后交付时，用户可能已经通过方向键进入菜单，不能再抢回第一项。
    if (
      "newState" in event &&
      event.newState === "open" &&
      !element.contains(document.activeElement)
    )
      buttons()[0]?.focus({ preventScroll: true });
  };
  element.addEventListener("keydown", keydown);
  element.addEventListener("toggle", toggle);
  return {
    destroy: () => {
      element.removeEventListener("keydown", keydown);
      element.removeEventListener("toggle", toggle);
    },
  };
}
