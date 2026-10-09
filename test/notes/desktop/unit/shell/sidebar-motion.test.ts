/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarMotion } from "@reader/renderer/sidebar-motion";
import { tick } from "svelte";

let node: HTMLElement;
let frame: FrameRequestCallback | undefined;
let media: EventTarget & { matches: boolean };
let animate: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
let animations: {
  currentTime: number;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
}[];
let resized: ResizeObserverCallback;
let anchor: HTMLElement;
let anchorLeft: number;

beforeEach(() => {
  node = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.className = "main";
  anchor = document.createElement("div");
  scroller.append(anchor);
  node.append(scroller);
  anchorLeft = 282;
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(anchorLeft, 0, 768, 100),
  );
  document.body.append(node);
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
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  cancel = vi.fn();
  animations = [];
  animate = vi.fn(() => {
    const animation = { currentTime: 0, cancel, onfinish: null };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(node, "animate", { value: animate });
});

afterEach(() => {
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("终点布局只用横向位移衔接，不缩放正文、不播放宽度动画", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  anchorLeft = 166;
  action?.update?.({ collapsed: true, narrow: false });
  await tick();
  const frames: Keyframe[] = animate.mock.calls[0]![0];
  expect(frames[0]).toEqual({ translate: "116px 0" });
  expect(frames.at(-1)).toEqual({ translate: "0px 0" });
  expect(frames.every((value) => Object.keys(value).length === 1)).toBe(true);
  expect(frame).toBeUndefined();
  action?.destroy?.();
  expect(cancel).toHaveBeenCalledOnce();
});

it("快速反向保留速度，系统减少动态效果取消剩余运动", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  anchorLeft = 166;
  action?.update?.({ collapsed: true, narrow: false });
  await tick();
  animations[0]!.currentTime = 80;
  node.style.translate = "40px 0";
  anchorLeft = 282;
  action?.update?.({ collapsed: false, narrow: false });
  await tick();
  const frames: Keyframe[] = animate.mock.calls[1]![0];
  const origin = Number.parseFloat(String(frames[0]!.translate));
  expect(origin).toBeGreaterThan(-116);
  expect(origin).toBeLessThan(0);
  // 反向的第一小段仍沿上一刻的速度前行，随后平滑转向最新目标。
  expect(Number.parseFloat(String(frames[1]!.translate))).toBeLessThan(origin);
  expect(cancel).toHaveBeenCalledOnce();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(cancel).toHaveBeenCalledTimes(2);
  action?.destroy?.();
});

it("抽屉、断点变化和挂载恢复不让正文横向追赶", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  action?.update?.({ collapsed: false, narrow: false });
  action?.update?.({ collapsed: false, narrow: true });
  action?.update?.({ collapsed: true, narrow: true });
  await tick();
  expect(animate).not.toHaveBeenCalled();
  action?.destroy?.();
});

it("动画途中拖动侧栏宽度，取消位移并立即跟随真实布局", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  anchorLeft = 166;
  action?.update?.({ collapsed: true, narrow: false });
  await tick();
  anchorLeft = 180;
  resized([], { observe() {}, unobserve() {}, disconnect() {} });
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledOnce();
  action?.destroy?.();
});

it("侧栏开合在首次绘制前按正文实际位置衔接，居中变化不重复补偿", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  anchorLeft = 166;
  action?.update?.({ collapsed: true, narrow: false });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0]![0][0]).toEqual({ translate: "116px 0" });
  expect(frame).toBeUndefined();
  action?.destroy?.();
});

it("助手开合也衔接正文，覆盖模式保持正文原位", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false, agentOpen: false });
  anchorLeft = 246;
  action?.update?.({ collapsed: false, narrow: false, agentOpen: true });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0]![0][0]).toEqual({ translate: "36px 0" });
  action?.destroy?.();
});

it("覆盖式助手开合不移动正文，待提交时卸载不残留动效", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false, agentOpen: false });
  action?.update?.({ collapsed: false, narrow: false, agentOpen: true });
  await tick();
  expect(animate).not.toHaveBeenCalled();
  anchorLeft = 246;
  action?.update?.({ collapsed: false, narrow: false, agentOpen: false });
  action?.destroy?.();
  await tick();
  expect(animate).not.toHaveBeenCalled();
});

it("同轮连续开合只衔接最终布局，窗口缩放直接对齐", async () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  action?.update?.({ collapsed: true, narrow: false });
  action?.update?.({ collapsed: false, narrow: false });
  await tick();
  expect(animate).not.toHaveBeenCalled();
  const original = window.innerWidth;
  window.innerWidth = original + 100;
  anchorLeft = 300;
  action?.update?.({ collapsed: true, narrow: false });
  await tick();
  window.innerWidth = original;
  expect(animate).not.toHaveBeenCalled();
  action?.destroy?.();
});
