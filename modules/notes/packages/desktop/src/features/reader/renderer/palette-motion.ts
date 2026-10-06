import type { Action } from "svelte/action";
import type { ReadingPalette } from "../shared/reading-palette";

/**
 * 配色变更时将前景和背景作为同一次绘制提交，避免明暗角色反转时短暂失去对比度。
 * @param node 应用根节点，拥有 data-reading-palette。
 * @param palette 当前已保存的配色；不会修改偏好、焦点或业务状态。
 * @returns 更新及卸载钩子；新配色完成一次绘制后恢复普通控件的状态过渡。
 * @throws 浏览器帧调度异常原样传播。
 */
export const paletteMotion: Action<HTMLElement, ReadingPalette> = (node, palette) => {
  const view = node.ownerDocument.defaultView;
  if (!view) return;
  let current = palette;
  let frame = 0;
  return {
    update(next) {
      if (next === current) return;
      current = next;
      view.cancelAnimationFrame(frame);
      node.setAttribute("data-palette-settling", "");
      // 第一帧让新配色完整绘制；第二帧撤掉门禁，避免同一帧内被样式合并。
      frame = view.requestAnimationFrame(() => {
        frame = view.requestAnimationFrame(() => {
          node.removeAttribute("data-palette-settling");
          frame = 0;
        });
      });
    },
    destroy() {
      view.cancelAnimationFrame(frame);
      node.removeAttribute("data-palette-settling");
    },
  };
};
