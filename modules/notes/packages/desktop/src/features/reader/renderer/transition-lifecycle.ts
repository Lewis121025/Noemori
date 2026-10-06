import type { Action } from "svelte/action";
import type { TransitionConfig } from "svelte/transition";

// 首次打开由组件先保存编辑现场；只有被退出流程关闭过的节点需要在进入时重开。
const exitingDialogs = new WeakSet<HTMLDialogElement>();

function milliseconds(value: string): number[] {
  return value
    .split(",")
    .map((time) => Number.parseFloat(time) * (time.trim().endsWith("ms") ? 1 : 1000))
    .filter(Number.isFinite);
}

/**
 * 重开退出过程中尚未卸载的弹窗；Svelte 复用节点时不会再执行 onMount。
 * @param node 条件挂载的 dialog；实际进入动效仍由 CSS 负责。
 * @returns 零时长的生命周期交接，不追加动画或延迟焦点。
 * @throws 原生 dialog 打开异常原样传播。
 */
export function dialogEnter(node: HTMLDialogElement): TransitionConfig {
  if (exitingDialogs.delete(node) && !node.open) node.showModal();
  return { duration: 0 };
}

/**
 * 原生关闭立即归还焦点，再保留退出尾帧的 DOM；业务动作不等待动画。
 * @param node 条件挂载的 dialog；CSS 负责 opacity/translate 和遮罩过渡。
 * @returns 与 CSS 退出时长一致的存活期；无过渡或减少动态效果时立即卸载。
 * @throws 原生 dialog 与 DOM 样式读取异常原样传播。
 */
export function dialogExit(node: HTMLDialogElement): TransitionConfig {
  exitingDialogs.add(node);
  if (node.open) node.close();
  const view = node.ownerDocument.defaultView;
  if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
    return { duration: 0 };
  const durations = milliseconds(view.getComputedStyle(node).transitionDuration);
  if (!durations.some((duration) => duration > 0)) return { duration: 0 };
  durations.push(...milliseconds(view.getComputedStyle(node, "::backdrop").transitionDuration));
  // 空关键帧仅为 Svelte 保留 DOM 存活期，不重复插值 CSS 已在播放的属性。
  return { duration: Math.max(0, ...durations) };
}

/**
 * 让 Svelte 管理的过渡响应运行中的“减少动态效果”，完成而非中断卸载流程。
 * @param node 仅绑定在拥有 Svelte 过渡的元素上，不查询或结束子孙节点的动画。
 * @returns 清除系统偏好和过渡事件监听；不创建逐帧调度。
 * @throws 浏览器完成动画的异常原样传播。
 */
export const finishOnReducedMotion: Action<HTMLElement> = (node) => {
  const media = node.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!media) return;
  let active = true;
  const finish = () => {
    if (!active || !media.matches) return;
    for (const animation of node.getAnimations()) {
      if (animation.playState === "running" || animation.playState === "paused") animation.finish();
    }
  };
  // Svelte 在 start 事件后建立实际动画；微任务也覆盖偏好改变时尚处于准备帧的情况。
  const started = () => queueMicrotask(finish);
  media.addEventListener("change", finish);
  node.addEventListener("introstart", started);
  node.addEventListener("outrostart", started);
  return {
    destroy() {
      active = false;
      media.removeEventListener("change", finish);
      node.removeEventListener("introstart", started);
      node.removeEventListener("outrostart", started);
    },
  };
};
