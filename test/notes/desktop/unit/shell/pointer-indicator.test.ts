/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pointerIndicator } from "@reader/renderer/pointer-indicator";

let node: HTMLElement;
let buttons: HTMLButtonElement[];
let frame: FrameRequestCallback | undefined;
let media: EventTarget & { matches: boolean };
let resize: ResizeObserverCallback;
let clock: number;
let animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[];
let animate: ReturnType<typeof vi.fn>;

function flush(elapsed = 8) {
  clock += elapsed;
  const callback = frame;
  frame = undefined;
  callback?.(clock);
}
function move(target: HTMLElement, x = 116, y = 35, pointerType = "mouse", pressed = 0) {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    buttons: { value: pressed },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: (clock += 8) },
  });
  target.dispatchEvent(event);
  flush();
}
function renderedPose() {
  const light = node.querySelector<HTMLElement>(".pointer-highlight")!;
  const value = light.style.transform;
  const numbers = value
    .slice(value.indexOf("(") + 1)
    .match(/-?\d*\.?\d+(?:e[+-]?\d+)?/g)!
    .map(Number);
  return {
    x: numbers[0]! + numbers[3]! * 16,
    y: numbers[1]! + numbers[4]! * 16,
    width: numbers[3]! * 32,
    height: numbers[4]! * 32,
  };
}
function start() {
  const action = pointerIndicator(node);
  Object.defineProperty(node.querySelector(".pointer-highlight"), "animate", { value: animate });
  return action;
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  node = document.createElement("div");
  buttons = [0, 1, 2].map((index) => {
    const button = document.createElement("button");
    const bounds = new DOMRect(100 + index * 40, 20, 32, 30);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(button, "getClientRects").mockReturnValue(
      Object.assign([bounds], { item: (index: number) => (index === 0 ? bounds : null) }),
    );
    node.append(button);
    return button;
  });
  document.body.append(node);
  const bounds = new DOMRect(100, 20, 120, 30);
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue(bounds);
  vi.spyOn(node, "getClientRects").mockReturnValue(
    Object.assign([bounds], { item: (index: number) => (index === 0 ? bounds : null) }),
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frame = undefined;
  });
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  animations = [];
  animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null };
    animations.push(animation);
    return animation;
  });
});
afterEach(() => {
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("控件内移动与快速反向都在首帧跟随，不播放追赶动画或移动焦点", () => {
  const action = start();
  buttons[0]!.focus();
  move(buttons[0]!, 116);
  expect(renderedPose().x).toBeCloseTo(16);
  move(buttons[0]!, 128);
  expect(renderedPose().x).toBeCloseTo(28);
  move(buttons[2]!, 196);
  expect(renderedPose().x).toBeCloseTo(96);
  move(buttons[0]!, 112);
  expect(renderedPose().x).toBeCloseTo(12);
  expect(animate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(buttons[0]);
  action?.destroy?.();
});

it("突然加速时形变逐步建立，位置仍在首帧对齐", () => {
  const action = start();
  move(buttons[0]!, 116);
  move(buttons[1]!, 156);
  expect(renderedPose().x).toBeCloseTo(56);
  expect(renderedPose().width).toBeGreaterThan(32);
  expect(renderedPose().width).toBeLessThan(32 * 1.05);
  const before = renderedPose().width;
  move(buttons[0]!, 116);
  expect(renderedPose().x).toBeCloseTo(16);
  expect(Math.abs(renderedPose().width - before)).toBeLessThan(32 * 0.05);
  action?.destroy?.();
});

it("穿过间隙持续跟随，速度带来伸展，停下只回收形状", () => {
  const gap = document.createElement("span");
  node.insertBefore(gap, buttons[1]!);
  const action = start();
  move(buttons[0]!, 116);
  move(gap, 136);
  expect(node.hasAttribute("data-hover-visible")).toBe(true);
  expect(renderedPose().x).toBeCloseTo(36);
  expect(renderedPose().width).toBeGreaterThan(32);
  expect(renderedPose().height).toBeLessThan(30);
  const moving = renderedPose();
  vi.advanceTimersByTime(40);
  clock += 40;
  flush();
  expect(renderedPose().width).toBeGreaterThan(32);
  expect(renderedPose().x).toBeCloseTo(36);
  expect(Math.abs(renderedPose().width - moving.width)).toBeLessThan(32 * 0.12);
  for (let index = 0; index < 72; index += 1) flush();
  expect(renderedPose().x).toBeCloseTo(36);
  expect(renderedPose().width).toBeCloseTo(32);
  expect(renderedPose().height).toBeCloseTo(30);
  expect(frame).toBeUndefined();
  move(buttons[1]!, 150);
  expect(animate).not.toHaveBeenCalled();
  expect(renderedPose().x).toBeCloseTo(50);
  action?.destroy?.();
});

it("离开后快速返回接续形变，退出完成后再进入恢复自然形状", () => {
  const action = start();
  move(buttons[0]!, 116);
  move(buttons[2]!, 196);
  flush(24);
  const moving = renderedPose().width;
  node.dispatchEvent(new Event("pointerleave"));
  move(buttons[2]!, 196);
  expect(renderedPose().x).toBeCloseTo(96);
  expect(renderedPose().width).toBeGreaterThan(32);
  expect(Math.abs(renderedPose().width - moving)).toBeLessThan(32 * 0.05);
  node.dispatchEvent(new Event("pointerleave"));
  animations.at(-1)!.onfinish?.();
  move(buttons[2]!, 196);
  expect(renderedPose().width).toBeCloseTo(32);
  action?.destroy?.();
});

it("轮廓接住斜向移动并在停顿后安静落定，文字与焦点保持原位", () => {
  const action = start();
  buttons[0]!.focus();
  move(buttons[0]!, 116, 35);
  move(buttons[1]!, 156, 40);
  flush(24);
  const body = node.querySelector<HTMLElement>(".pointer-body")!;
  const wake = node.querySelector<HTMLElement>(".pointer-wake")!;
  expect(body.style.transform).toMatch(/^matrix\(/);
  expect(body.style.transform.split(",")[1]).not.toBe("0");
  expect(Number(wake.style.opacity)).toBeGreaterThan(0);
  vi.advanceTimersByTime(40);
  clock += 40;
  for (let index = 0; index < 72; index += 1) flush();
  expect(Number(wake.style.opacity)).toBe(0);
  expect(body.style.transform).toBe("matrix(0.84,0,0,0.84,0,0)");
  expect(frame).toBeUndefined();
  expect(document.activeElement).toBe(buttons[0]);
  action?.destroy?.();
});

it("减少动态效果取消回收动画，正文键盘接管与卸载释放反馈", () => {
  const action = start();
  move(buttons[0]!, 116);
  move(buttons[1]!, 156);
  vi.advanceTimersByTime(40);
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  flush();
  expect(frame).toBeUndefined();
  expect(renderedPose().width).toBeCloseTo(32);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  move(buttons[2]!, 196);
  node.dispatchEvent(new Event("pointerleave"));
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  action?.destroy?.();
  expect(node.querySelector(".pointer-highlight")).toBeNull();
  expect(node.hasAttribute("data-motion-hover")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("触摸、禁用、拖动与内层浮层不借用外层光照，原生关闭立即收回", () => {
  const action = start();
  move(buttons[0]!, 116, 35, "touch");
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  buttons[1]!.disabled = true;
  move(buttons[1]!, 156);
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  move(buttons[0]!, 116);
  move(buttons[0]!, 118, 35, "mouse", 1);
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  const nested = document.createElement("div");
  nested.setAttribute("popover", "auto");
  const child = document.createElement("button");
  nested.append(child);
  node.append(nested);
  move(buttons[0]!, 116);
  move(child, 116);
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  move(buttons[0]!, 116);
  const closing = new Event("beforetoggle");
  Object.defineProperty(closing, "newState", { value: "closed" });
  node.dispatchEvent(closing);
  expect(node.hasAttribute("data-hover-visible")).toBe(false);
  action?.destroy?.();
  move(buttons[0]!, 116);
  expect(frame).toBeUndefined();
});

it("连续输入复用几何，尺寸变化才重建，不逐帧测量所有控件", () => {
  const action = start();
  move(buttons[0]!, 116);
  for (const button of buttons) vi.mocked(button.getBoundingClientRect).mockClear();
  for (let index = 0; index < 12; index += 1) move(buttons[0]!, 116 + index);
  for (const button of buttons) expect(button.getBoundingClientRect).not.toHaveBeenCalled();
  resize([], { observe() {}, unobserve() {}, disconnect() {} });
  flush();
  for (const button of buttons) expect(button.getBoundingClientRect).toHaveBeenCalledOnce();
  action?.destroy?.();
});
