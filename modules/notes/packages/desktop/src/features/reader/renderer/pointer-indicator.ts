import type { Action } from "svelte/action";
import {
  createPointerSurface,
  pointerContour,
  pointerSurface,
  samplePointerFlow,
  type PointerBounds,
  type PointerPoint,
  type PointerSurface,
  type PointerFlow,
} from "./pointer-surface";

const transform = (bounds: PointerBounds) =>
  `translate3d(${bounds.x}px, ${bounds.y}px, 0) scale(${bounds.width / 32}, ${bounds.height / 32})`;
const restingFlow: PointerFlow = { x: 0, y: 0, dx: 0, dy: 0, settled: true };

/**
 * 光斑中心同帧跟随光标；方向形变与尾部轻微回弹，离开时柔和消退。
 * @param node 工具栏、菜单或文件列表；内层浮层独立响应，触摸与禁用项不触发。
 * @returns 卸载时释放装饰层、帧、计时器和监听；交互不改变文字、命中区域或焦点。
 * @throws 非法 DOM 几何和浏览器动画异常原样传播。
 */
export const pointerIndicator: Action<HTMLElement> = (node) => {
  const view = node.ownerDocument.defaultView;
  if (!view) return;
  const media = view.matchMedia("(prefers-reduced-motion: reduce)");
  const light = node.ownerDocument.createElement("div");
  light.className = "pointer-highlight";
  light.setAttribute("aria-hidden", "true");
  const body = node.ownerDocument.createElement("span");
  body.className = "pointer-body";
  const wake = node.ownerDocument.createElement("span");
  wake.className = "pointer-wake";
  light.append(wake, body);
  node.append(light);
  node.setAttribute("data-motion-hover", "");
  let live = true,
    dirty = true,
    frame = 0;
  let rest: ReturnType<typeof setTimeout> | undefined;
  let path: PointerSurface | null = null;
  let point: PointerPoint | null = null;
  let velocity: PointerPoint = { x: 0, y: 0 };
  let lastTime = 0;
  let paintedAt: number | null = null;
  let flow = restingFlow;
  let button: HTMLElement | null = null;
  let pose: PointerBounds | null = null;
  let animation: Animation | null = null;

  function stop(preserve = true): void {
    if (!animation) return;
    const shown = preserve ? view!.getComputedStyle(light).transform : null;
    animation.onfinish = null;
    animation.cancel();
    animation = null;
    if (shown && shown !== "none") light.style.transform = shown;
  }
  function animateTo(next: PointerBounds, duration: number): void {
    stop();
    const from = light.style.transform;
    pose = next;
    light.style.transform = transform(next);
    if (
      media.matches ||
      !from ||
      from === light.style.transform ||
      typeof light.animate !== "function"
    ) {
      if (!point) flow = restingFlow;
      return;
    }
    animation = light.animate([{ transform: from }, { transform: transform(next) }], {
      duration,
      easing: "cubic-bezier(0.2, 0.8, 0.3, 1)",
    });
    animation.onfinish = () => {
      stop(false);
      if (!point) flow = restingFlow;
    };
  }
  function clear(): void {
    if (!point) return;
    point = null;
    button = null;
    paintedAt = null;
    // 退出仍可见时保留方向和形变动量，快速返回可以接续这一刻的轮廓。
    clearTimeout(rest);
    view!.cancelAnimationFrame(frame);
    frame = 0;
    node.removeAttribute("data-hover-visible");
    if (pose)
      animateTo(
        {
          x: pose.x + pose.width * 0.015,
          y: pose.y + pose.height * 0.015,
          width: pose.width * 0.97,
          height: pose.height * 0.97,
        },
        140,
      );
  }
  function belongs(target: Element): boolean {
    const popover = target.closest("[popover]");
    return target.closest("[data-motion-hover]") === node && (!popover || popover === node);
  }
  function measure(parent: DOMRect): void {
    const targets = new Set<HTMLElement>();
    for (const control of Array.from(
      node.querySelectorAll<HTMLElement>("button, summary, [role=option]"),
    )) {
      if (
        !belongs(control) ||
        control.closest(":disabled, [aria-disabled=true], [hidden], [inert]") ||
        !control.getClientRects().length
      )
        continue;
      targets.add(control.closest<HTMLElement>("[data-hover-target]") ?? control);
    }
    const bounds: PointerBounds[] = [];
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      bounds.push({
        x: rect.left - parent.left + node.scrollLeft - node.clientLeft,
        y: rect.top - parent.top + node.scrollTop - node.clientTop,
        width: rect.width,
        height: rect.height,
      });
    }
    path = createPointerSurface(bounds);
    dirty = false;
  }
  function nextPose(elapsed: number): PointerBounds | null {
    if (!point || node.closest("[hidden], [inert]") || !node.getClientRects().length) return null;
    const parent = node.getBoundingClientRect();
    if (dirty) measure(parent);
    if (!path) return null;
    const contact = {
      x: point.x - parent.left + node.scrollLeft - node.clientLeft,
      y: point.y - parent.top + node.scrollTop - node.clientTop,
    };
    const natural = pointerSurface(path, contact, 0);
    if (!natural) return null;
    flow = media.matches
      ? restingFlow
      : samplePointerFlow(
          flow,
          { x: (velocity.x * 32) / natural.width, y: (velocity.y * 32) / natural.height },
          elapsed,
        );
    const contour = pointerContour(flow);
    body.style.transform = `matrix(${contour.body.join(",")},0,0)`;
    wake.style.transform = `translate(${contour.wake.x}px,${contour.wake.y}px) scale(${contour.wake.scale})`;
    wake.style.opacity = String(contour.wake.opacity);
    return pointerSurface(path, contact, contour.stretch);
  }
  function paint(time: number): void {
    frame = 0;
    if (!live || !point) return;
    const next = nextPose(Math.max(0, time - (paintedAt ?? lastTime)));
    paintedAt = time;
    if (!next) {
      clear();
      return;
    }
    stop();
    pose = next;
    // 装饰层只提交 transform/opacity，形变不会让文字或命中区域参与布局。
    light.style.transform = transform(next);
    if (!node.hasAttribute("data-hover-visible")) node.setAttribute("data-hover-visible", "");
    if (!flow.settled) schedule();
  }
  function schedule(): void {
    if (live && point && !frame) frame = view!.requestAnimationFrame(paint);
  }
  function settle(): void {
    rest = undefined;
    velocity = { x: 0, y: 0 };
    schedule();
  }
  function move(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
    if (event.buttons > 0) {
      clear();
      return;
    }
    if (!belongs(event.target)) {
      clear();
      return;
    }
    const target = event.target.closest<HTMLElement>("button, summary, [role=option]");
    if (target?.closest(":disabled, [aria-disabled=true], [hidden], [inert]")) {
      clear();
      return;
    }
    if (!target && !point) return;
    if (point?.x === event.clientX && point.y === event.clientY && (!target || target === button))
      return;
    const elapsed = Math.max(1, event.timeStamp - lastTime);
    velocity =
      point && elapsed < 100
        ? { x: (event.clientX - point.x) / elapsed, y: (event.clientY - point.y) / elapsed }
        : { x: 0, y: 0 };
    point = { x: event.clientX, y: event.clientY };
    lastTime = event.timeStamp;
    if (!frame) paintedAt = event.timeStamp;
    if (target) button = target;
    clearTimeout(rest);
    rest = media.matches ? undefined : setTimeout(settle, 40);
    schedule();
  }
  function invalidate(): void {
    dirty = true;
    if (
      button &&
      (!button.isConnected ||
        !node.contains(button) ||
        button.closest(":disabled, [aria-disabled=true], [hidden], [inert]"))
    )
      clear();
    else schedule();
  }
  const closing = (event: ToggleEvent) => {
    if (event.target === node && event.newState === "closed") clear();
  };
  const preferenceChanged = () => {
    stop();
    clearTimeout(rest);
    velocity = { x: 0, y: 0 };
    flow = restingFlow;
    schedule();
  };
  const focused = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) clear();
  };
  const observer = new ResizeObserver(invalidate);
  observer.observe(node);
  const contents = new MutationObserver(invalidate);
  contents.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled", "hidden", "inert"],
  });
  node.addEventListener("pointerover", move);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerleave", clear);
  node.addEventListener("pointerdown", clear);
  node.addEventListener("scroll", clear, true);
  node.addEventListener("beforetoggle", closing);
  node.ownerDocument.addEventListener("keydown", clear, true);
  node.ownerDocument.addEventListener("focusin", focused, true);
  media.addEventListener("change", preferenceChanged);
  return {
    destroy() {
      live = false;
      clearTimeout(rest);
      view.cancelAnimationFrame(frame);
      stop(false);
      observer.disconnect();
      contents.disconnect();
      node.removeEventListener("pointerover", move);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", clear);
      node.removeEventListener("pointerdown", clear);
      node.removeEventListener("scroll", clear, true);
      node.removeEventListener("beforetoggle", closing);
      node.ownerDocument.removeEventListener("keydown", clear, true);
      node.ownerDocument.removeEventListener("focusin", focused, true);
      media.removeEventListener("change", preferenceChanged);
      light.remove();
      node.removeAttribute("data-motion-hover");
      node.removeAttribute("data-hover-visible");
    },
  };
};
