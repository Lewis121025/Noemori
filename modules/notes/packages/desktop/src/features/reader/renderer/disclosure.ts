import { slide, type TransitionConfig } from "svelte/transition";
import { cubicInOut } from "svelte/easing";

/**
 * 大纲按真实内容高度展开，内容越长收尾稍慢，时长限制在 160–260ms。
 * @param node 即将进入或退出的分组；由 Svelte 管理反向、卸载和退出期间的 inert。
 * @returns 原生 Svelte 过渡配置；减少动态效果时立即完成。
 * @throws DOM 样式读取异常原样传播。
 */
export function disclosure(node: HTMLElement): TransitionConfig {
  const reduced = node.ownerDocument.defaultView?.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  return slide(node, {
    duration: reduced ? 0 : Math.min(260, 160 + Math.sqrt(node.scrollHeight) * 5),
    easing: cubicInOut,
  });
}
