import type { Action } from "svelte/action";
import { tick } from "svelte";

/** 动效仅接收展示状态的稳定标识；禁止传入编辑器事务或逐帧指针坐标。 */
type MotionValue = string | number | boolean | null;

/** 内容角色决定视觉重量；标识只在对应展示内容真正变化时更新。 */
type ContentMotion =
  | { key: MotionValue; kind: "document" | "panel" | "preview" | "media" }
  | { key: MotionValue; kind: "navigation"; direction: -1 | 1 };

const contentProfiles = {
  document: { opacity: 0.97, offset: 0, token: "--motion-scene" },
  panel: { opacity: 0.9, offset: 4, token: "--motion-enter" },
  navigation: { opacity: 0.9, offset: 8, token: "--motion-enter" },
  preview: { opacity: 0.9, offset: 3, token: "--motion-enter" },
  media: { opacity: 0.98, offset: 0, token: "--motion-scene" },
};

/** 每个挂载边界只管理自己创建的动画，取消时不触碰编辑器或浏览器的动画。 */
function motionScope(host: HTMLElement) {
  const view = host.ownerDocument.defaultView;
  const media = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const running = new Map<HTMLElement, Animation>();
  const cancel = () => {
    for (const animation of running.values()) {
      animation.onfinish = null;
      animation.cancel();
    }
    running.clear();
  };
  const preferenceChanged = () => {
    if (media?.matches) cancel();
  };
  media?.addEventListener("change", preferenceChanged);
  return {
    play(
      target: HTMLElement,
      kind: ContentMotion["kind"] | "keyboard",
      direction: -1 | 1 = 1,
    ): void {
      if (
        !view ||
        media?.matches ||
        !target.isConnected ||
        target.closest("[hidden], [inert]") ||
        typeof target.animate !== "function"
      ) {
        const previous = running.get(target);
        if (previous) {
          previous.onfinish = null;
          previous.cancel();
          running.delete(target);
        }
        return;
      }
      const profile = kind === "keyboard" ? null : contentProfiles[kind];
      const style = view.getComputedStyle(target);
      const duration = Number.parseFloat(style.getPropertyValue(profile?.token ?? "--motion-fast"));
      if (!Number.isFinite(duration) || duration <= 0) return;
      const previous = running.get(target);
      // 必须在取消前复制呈现值，再读取底层样式，避免快速切换回到动画起点。
      const shown = { opacity: style.opacity, translate: style.translate, shadow: style.boxShadow };
      if (previous) {
        previous.onfinish = null;
        previous.cancel();
      }
      const resting = view.getComputedStyle(target);
      const opacity = Number(resting.opacity || 1);
      const shadow = resting.boxShadow || "none";
      const frames: Keyframe[] =
        profile === null
          ? [
              {
                boxShadow: previous
                  ? shown.shadow
                  : `inset 0 0 0 1px color-mix(in srgb, currentColor 36%, transparent), ${shadow === "none" ? "0 0 0 0 transparent" : shadow}`,
              },
              { boxShadow: shadow },
            ]
          : [
              {
                opacity: previous ? Number(shown.opacity || 1) : opacity * profile.opacity,
                ...(profile.offset > 0
                  ? {
                      translate: previous
                        ? shown.translate
                        : kind === "navigation"
                          ? `${direction * profile.offset}px 0`
                          : `0 ${profile.offset}px`,
                    }
                  : {}),
              },
              {
                opacity,
                ...(profile.offset > 0 ? { translate: resting.translate || "none" } : {}),
              },
            ];
      const animation = target.animate(frames, {
        duration,
        easing: resting.getPropertyValue("--motion-ease").trim() || "ease-out",
      });
      running.set(target, animation);
      animation.onfinish = () => {
        running.delete(target);
        animation.onfinish = null;
        animation.cancel();
      };
    },
    destroy(): void {
      media?.removeEventListener("change", preferenceChanged);
      cancel();
    },
  };
}

/**
 * 为键盘激活补充短暂边界反馈；指针按压由 CSS 原生 active 状态承担。
 * @param node 应用根节点；禁用、隐藏、inert 控件以及文本输入不触发反馈。
 * @returns 卸载时清除事件监听与尚未完成的动画；无 DOM 动画能力时保持原行为。
 * @throws 浏览器动画 API 的异常原样传播。
 */
export const interactionFeedback: Action<HTMLElement> = (node) => {
  const motion = motionScope(node);
  const clicked = (event: MouseEvent) => {
    if (event.detail !== 0 || !(event.target instanceof Element)) return;
    const target = event.target.closest(
      "button, summary, a[href], input[type=checkbox], [role=option]",
    );
    if (
      !(target instanceof HTMLElement) ||
      !node.contains(target) ||
      target.closest(":disabled, [aria-disabled=true], [inert], [hidden]")
    )
      return;
    motion.play(target, "keyboard");
  };
  // 捕获阶段先给反馈；业务回调可以立即关闭面板或卸载控件，无需等待动效。
  node.addEventListener("click", clicked, true);
  return {
    destroy() {
      node.removeEventListener("click", clicked, true);
      motion.destroy();
    },
  };
};

/**
 * 按内容角色衔接现有节点；正文只做极轻的明度交接，辅助内容才使用小幅位移。
 * @param node 展示状态的宿主节点。
 * @param value 展示内容的稳定标识和角色；初始挂载与同标识更新不播放。
 * @returns 更新和卸载钩子；快速更新替换旧动效，减少动态效果变化立即取消。
 * @throws 浏览器动画 API 的异常原样传播。
 */
export const revealOnChange: Action<HTMLElement, ContentMotion> = (node, value) => {
  const motion = motionScope(node);
  let current = value;
  let pending = false;
  let active = true;
  return {
    update(next) {
      if (Object.is(current.key, next.key) && current.kind === next.kind) return;
      current = next;
      if (pending) return;
      pending = true;
      // action 更新可能早于 hidden/inert 属性提交，先完成本轮 DOM 更新再判断可见性。
      void tick().then(() => {
        pending = false;
        if (active)
          motion.play(node, current.kind, current.kind === "navigation" ? current.direction : 1);
      });
    },
    destroy() {
      active = false;
      motion.destroy();
    },
  };
};
