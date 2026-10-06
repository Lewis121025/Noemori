import type { Action } from "svelte/action";

/** 窄屏抽屉覆盖正文，只有桌面侧栏开合才需要衔接正文横向位置。 */
type SidebarLayout = { collapsed: boolean; narrow: boolean };

/**
 * 侧栏状态改变后只排版一次，再以位移衔接正文容器，避免长文逐帧换行。
 * @param node 侧栏旁的内容容器；本动作独占该容器的 translate 动画。
 * @param value 当前侧栏状态；拖宽和窗口缩放不播放追赶动画。
 * @returns 更新及清理钩子；快速反向从当前呈现位置续接，减少动态效果立即取消。
 * @throws DOM 测量和浏览器动画异常原样传播。
 */
export const sidebarMotion: Action<HTMLElement, SidebarLayout> = (node, value) => {
  const view = node.ownerDocument.defaultView;
  if (!view) return;
  const media = view.matchMedia("(prefers-reduced-motion: reduce)");
  let current = value;
  let left = node.offsetLeft;
  let windowWidth = view.innerWidth;
  let frame = 0;
  let animation: Animation | null = null;

  function cancel(): void {
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
      animation = null;
    }
  }

  const align = (): void => {
    view.cancelAnimationFrame(frame);
    frame = 0;
    cancel();
    left = node.offsetLeft;
    windowWidth = view.innerWidth;
  };

  const play = (): void => {
    frame = 0;
    const style = view.getComputedStyle(node);
    const offset = Number.parseFloat(style.translate) || 0;
    const from = left + offset;
    cancel();
    left = node.offsetLeft;
    const resized = windowWidth !== view.innerWidth;
    windowWidth = view.innerWidth;
    if (current.narrow || media.matches || resized || Math.abs(from - left) < 0.5) return;
    const duration = Number.parseFloat(style.getPropertyValue("--motion-enter"));
    if (!Number.isFinite(duration) || duration <= 0) return;
    animation = node.animate([{ translate: `${from - left}px 0` }, { translate: "0px 0" }], {
      duration,
      easing: style.getPropertyValue("--motion-ease").trim() || "ease-out",
      fill: "both",
    });
    animation.onfinish = cancel;
  };

  const observer = new ResizeObserver(() => {
    // 状态更新的测量必须等本轮 Svelte DOM 更新结束，观察器不能提前覆盖旧位置。
    if (frame !== 0) return;
    if (windowWidth !== view.innerWidth || left !== node.offsetLeft) cancel();
    left = node.offsetLeft;
    windowWidth = view.innerWidth;
  });
  observer.observe(node);
  const preferenceChanged = () => {
    if (media.matches) align();
  };
  media.addEventListener("change", preferenceChanged);
  return {
    update(next) {
      if (next.collapsed === current.collapsed && next.narrow === current.narrow) return;
      const changedViewport = next.narrow !== current.narrow;
      current = next;
      if (changedViewport || next.narrow || media.matches) {
        align();
        return;
      }
      if (!frame) frame = view.requestAnimationFrame(play);
    },
    destroy() {
      observer.disconnect();
      media.removeEventListener("change", preferenceChanged);
      view.cancelAnimationFrame(frame);
      cancel();
    },
  };
};
