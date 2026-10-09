import { tick } from "svelte";
import type { Action } from "svelte/action";
import { advanceMotion, type MotionCoordinate } from "./spatial-motion";

/** 侧栏只发布开合状态；宽度拖动和窗口尺寸变化直接跟随真实布局。 */
export type SidebarLayout = { collapsed: boolean; narrow: boolean; agentOpen?: boolean };

/**
 * 每栏按正文实际横向位置衔接左右侧栏开合，长文只在终点排版一次。
 * @param node 本栏滚动区的容器；正文锚点为 .main 的直接子元素。
 * @param value 左右侧栏状态；窄屏覆盖正文时不追加位移。
 * @returns 更新及清理钩子；首次绘制前建立动效，快速反向保留位置与速度。
 * @throws DOM 测量、无效几何和浏览器动画异常原样传播。
 */
export const sidebarMotion: Action<HTMLElement, SidebarLayout> = (node, value) => {
  const owner = node.ownerDocument.defaultView;
  if (!owner) return;
  const view = owner;
  const media = view.matchMedia("(prefers-reduced-motion: reduce)");
  let current = value;
  let left = measure();
  let width = node.offsetWidth;
  let windowWidth = view.innerWidth;
  let pending = false;
  let active = true;
  let position: MotionCoordinate = { position: 0, velocity: 0 };
  let animation: Animation | null = null;

  function measure(): number {
    return (node.querySelector<HTMLElement>(".main > div") ?? node).getBoundingClientRect().left;
  }

  function cancel(): void {
    if (!animation) return;
    animation.onfinish = null;
    animation.cancel();
    animation = null;
  }

  function align(): void {
    cancel();
    position = { position: 0, velocity: 0 };
    left = measure();
    width = node.offsetWidth;
    windowWidth = view.innerWidth;
  }

  function play(): void {
    pending = false;
    if (!active) return;
    const elapsed = typeof animation?.currentTime === "number" ? animation.currentTime : 0;
    const shown = advanceMotion(position, 0, Math.max(0, elapsed) / 1000);
    const presented = animation ? Number.parseFloat(view.getComputedStyle(node).translate) || 0 : 0;
    cancel();
    const next = measure();
    const resized = windowWidth !== view.innerWidth;
    windowWidth = view.innerWidth;
    width = node.offsetWidth;
    // 位置取浏览器实际插值结果，速度取解析解，避免采样关键帧带来亚像素跳变。
    position = { position: left + presented - next, velocity: shown.velocity };
    left = next;
    if (
      current.narrow ||
      media.matches ||
      resized ||
      !node.isConnected ||
      typeof node.animate !== "function" ||
      node.closest("[hidden]") ||
      (Math.abs(position.position) < 0.1 && Math.abs(position.velocity) < 1)
    ) {
      align();
      return;
    }
    const frames: Keyframe[] = [{ translate: `${position.position}px 0` }];
    let step = 0;
    let sample = position;
    // 仅采样位移交给合成线程；不缩放文字，不逐帧写继承样式或重排长文。
    while (Math.abs(sample.position) >= 0.1 || Math.abs(sample.velocity) >= 1) {
      sample = advanceMotion(position, 0, ++step / 120);
      frames.push({ translate: `${sample.position}px 0` });
    }
    frames[frames.length - 1] = { translate: "0px 0" };
    animation = node.animate(frames, {
      duration: (step / 120) * 1000,
      easing: "linear",
      fill: "both",
    });
    animation.onfinish = align;
  }

  const observer = new ResizeObserver(() => {
    if (pending || !active) return;
    const offset = Number.parseFloat(view.getComputedStyle(node).translate) || 0;
    if (
      windowWidth !== view.innerWidth ||
      width !== node.offsetWidth ||
      Math.abs(measure() - offset - left) >= 0.5
    )
      align();
  });
  observer.observe(node);
  const preferenceChanged = () => {
    if (media.matches) align();
  };
  media.addEventListener("change", preferenceChanged);
  return {
    update(next) {
      if (
        next.collapsed === current.collapsed &&
        next.narrow === current.narrow &&
        next.agentOpen === current.agentOpen
      )
        return;
      current = next;
      if (pending) return;
      pending = true;
      // RAF 会把终点布局先绘制一帧；tick 在 DOM 更新完成后、绘制前提交起点。
      void tick().then(play);
    },
    destroy() {
      active = false;
      observer.disconnect();
      media.removeEventListener("change", preferenceChanged);
      cancel();
    },
  };
};
