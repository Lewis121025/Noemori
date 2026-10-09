import type { Action } from "svelte/action";
import { advanceMotion, type MotionCoordinate } from "./spatial-motion";

const axes = ["x", "y", "width", "height"] as const;
/** 底色使用容器内容坐标，滚动由原生布局承担，不进入动画状态机。 */
type Bounds = Record<(typeof axes)[number], number>;
/** 一次浏览器动画的起始状态；中途改向按真实播放时间求解，保持速度连续。 */
type Motion = Record<(typeof axes)[number], MotionCoordinate>;

function atRest(bounds: Bounds): Motion {
  return {
    x: { position: bounds.x, velocity: 0 },
    y: { position: bounds.y, velocity: 0 },
    width: { position: bounds.width, velocity: 0 },
    height: { position: bounds.height, velocity: 0 },
  };
}

function advance(current: Motion, target: Bounds, seconds: number): Motion {
  return {
    x: advanceMotion(current.x, target.x, seconds),
    y: advanceMotion(current.y, target.y, seconds),
    width: advanceMotion(current.width, target.width, seconds),
    height: advanceMotion(current.height, target.height, seconds),
  };
}

function settled(current: Motion, target: Bounds): boolean {
  return axes.every(
    (axis) =>
      Math.abs(current[axis].position - target[axis]) < 0.1 && Math.abs(current[axis].velocity) < 1,
  );
}

function keyframe(current: Motion): Keyframe {
  return {
    translate: `${current.x.position}px ${current.y.position}px`,
    width: `${current.width.position}px`,
    height: `${current.height.position}px`,
  };
}

/**
 * 让互斥选项共享一块移动的底色，保持按钮文字、命中区域和焦点原位。
 * @param node 直接包含 aria-pressed 按钮的导航容器。
 * @param value 当前选择的稳定标识；改目标保持当前位置和速度，不排队。
 * @returns 更新与卸载钩子；首次显示、尺寸变化、减少动态效果直接对齐。
 * @throws DOM 测量异常或非有限坐标原样传播。
 */
export const selectionIndicator: Action<HTMLElement, string> = (node, value) => {
  const view = node.ownerDocument.defaultView;
  if (!view) return;
  const requestFrame = view.requestAnimationFrame.bind(view);
  const media = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  let current = value;
  let frame = 0;
  let pending: "snap" | "move" | null = null;
  let position: Motion | null = null;
  let target: Bounds | null = null;
  let animation: Animation | null = null;

  function measure(): Bounds | null {
    const selected = node.querySelector<HTMLButtonElement>(":scope > button[aria-pressed=true]");
    if (!selected || !node.isConnected || node.getClientRects().length === 0) return null;
    const parent = node.getBoundingClientRect();
    const button = selected.getBoundingClientRect();
    return {
      x: button.left - parent.left + node.scrollLeft - node.clientLeft,
      y: button.top - parent.top + node.scrollTop - node.clientTop,
      width: button.width,
      height: button.height,
    };
  }

  function cancel(): void {
    if (!animation) return;
    animation.onfinish = null;
    animation.cancel();
    animation = null;
  }

  function tick(): void {
    frame = 0;
    const snap = pending === "snap" || media?.matches || position === null;
    // 使用浏览器播放时钟而非 RAF 次数；主线程偶有长任务也不会积压补帧。
    if (animation && position && target) {
      const elapsed = typeof animation.currentTime === "number" ? animation.currentTime : 0;
      position = advance(position, target, Math.max(0, elapsed) / 1000);
    }
    const next = measure();
    cancel();
    target = next;
    pending = null;
    if (!target) {
      node.removeAttribute("data-selection-ready");
      position = null;
      return;
    }
    // 容器变量只提交终点一次，避免动画每帧使全部后代重新计算继承样式。
    for (const axis of axes) node.style.setProperty(`--selection-${axis}`, `${target[axis]}px`);
    node.setAttribute("data-selection-ready", "");
    if (snap || !position || settled(position, target)) {
      position = atRest(target);
      return;
    }
    const keyframes = [keyframe(position)];
    let step = 0;
    let sample = position;
    // 按解析轨迹采样交给 WAAPI 插值；120Hz 采样只决定曲线精度，不依赖设备刷新率。
    while (!settled(sample, target)) {
      sample = advance(position, target, ++step / 120);
      keyframes.push(keyframe(sample));
    }
    keyframes[keyframes.length - 1] = keyframe(atRest(target));
    // 等尺寸选项只有位移，交给合成线程；尺寸确有变化时才为底色生成布局属性。
    for (const axis of ["width", "height"] as const) {
      if (position[axis].position === target[axis] && position[axis].velocity === 0)
        for (const frame of keyframes) delete frame[axis];
    }
    const destination = target;
    animation = node.animate(keyframes, {
      duration: (step / 120) * 1000,
      easing: "linear",
      fill: "both",
      pseudoElement: "::before",
    });
    animation.onfinish = () => {
      position = atRest(destination);
      cancel();
    };
  }

  function schedule(mode: "snap" | "move"): void {
    // 同一帧发生尺寸改变时优先直接对齐，避免拖动侧栏时底色追赶按钮。
    if (pending !== "snap") pending = mode;
    if (!frame) frame = requestFrame(tick);
  }
  const preferenceChanged = () => {
    if (media?.matches) schedule("snap");
  };
  node.setAttribute("data-motion-selection", "");
  const observer = new ResizeObserver(() => schedule("snap"));
  observer.observe(node);
  for (const child of Array.from(node.children)) observer.observe(child);
  media?.addEventListener("change", preferenceChanged);
  schedule("snap");
  return {
    update(next) {
      if (current === next) return;
      current = next;
      schedule("move");
    },
    destroy() {
      observer.disconnect();
      media?.removeEventListener("change", preferenceChanged);
      view.cancelAnimationFrame(frame);
      cancel();
      node.removeAttribute("data-motion-selection");
      node.removeAttribute("data-selection-ready");
      for (const axis of axes) node.style.removeProperty(`--selection-${axis}`);
    },
  };
};
