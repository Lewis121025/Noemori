/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarMotion } from "@reader/renderer/sidebar-motion";

let node: HTMLElement;
let left: number;
let frame: FrameRequestCallback | undefined;
let media: EventTarget & { matches: boolean };
let animate: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
let resized: ResizeObserverCallback;

beforeEach(() => {
  node = document.createElement("div");
  node.style.setProperty("--motion-enter", "220ms");
  document.body.append(node);
  left = 232;
  Object.defineProperty(node, "offsetLeft", { get: () => left });
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
  animate = vi.fn(() => ({ cancel, onfinish: null }));
  Object.defineProperty(node, "animate", { value: animate });
});

afterEach(() => {
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(): void {
  const callback = frame;
  frame = undefined;
  callback?.(16);
}

it("终点布局只用横向位移衔接，不缩放正文、不播放宽度动画", () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  left = 0;
  action?.update?.({ collapsed: true, narrow: false });
  render();
  expect(animate).toHaveBeenCalledWith(
    [{ translate: "232px 0" }, { translate: "0px 0" }],
    expect.objectContaining({ duration: 220 }),
  );
  expect(frame).toBeUndefined();
  action?.destroy?.();
  expect(cancel).toHaveBeenCalledOnce();
});

it("快速反向沿用正在呈现的位置，系统减少动态效果取消剩余运动", () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  left = 0;
  action?.update?.({ collapsed: true, narrow: false });
  render();
  node.style.translate = "80px 0";
  left = 232;
  action?.update?.({ collapsed: false, narrow: false });
  render();
  expect(animate.mock.calls[1]![0][0]).toEqual({ translate: "-152px 0" });
  expect(cancel).toHaveBeenCalledOnce();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(cancel).toHaveBeenCalledTimes(2);
  action?.destroy?.();
});

it("抽屉、断点变化和挂载恢复不让正文横向追赶", () => {
  const action = sidebarMotion(node, { collapsed: false, narrow: false });
  action?.update?.({ collapsed: false, narrow: false });
  action?.update?.({ collapsed: false, narrow: true });
  action?.update?.({ collapsed: true, narrow: true });
  render();
  expect(animate).not.toHaveBeenCalled();
  action?.destroy?.();
});

it("动画途中拖动侧栏宽度，取消位移并立即跟随真实布局", () => {
  left = 0;
  const action = sidebarMotion(node, { collapsed: true, narrow: false });
  left = 232;
  action?.update?.({ collapsed: false, narrow: false });
  render();
  left = 260;
  resized([], { observe() {}, unobserve() {}, disconnect() {} });
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledOnce();
  action?.destroy?.();
});
