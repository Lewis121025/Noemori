/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectionIndicator } from "@reader/renderer/selection-indicator";

let node: HTMLElement;
let selected: HTMLButtonElement;
let frames: Map<number, FrameRequestCallback>;
let media: EventTarget & { matches: boolean };
let resize: ResizeObserverCallback;
let animations: Array<{
  currentTime: number;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
}>;
let animate: ReturnType<typeof vi.fn>;

function flushFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(16));
}

beforeEach(() => {
  node = document.createElement("nav");
  selected = document.createElement("button");
  selected.setAttribute("aria-pressed", "true");
  node.append(selected);
  document.body.append(node);
  vi.spyOn(node, "getClientRects").mockReturnValue(
    Object.assign([new DOMRect()], { item: () => null }),
  );
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 40));
  vi.spyOn(selected, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 40, 32));
  frames = new Map();
  let sequence = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
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
    const animation: (typeof animations)[number] = {
      currentTime: 0,
      cancel: vi.fn(),
      onfinish: null,
    };
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

it("初次对齐后由浏览器播放底色，不逐帧更新容器样式", () => {
  const action = selectionIndicator(node, "first");
  flushFrame();
  expect(animate).not.toHaveBeenCalled();
  vi.mocked(selected.getBoundingClientRect).mockReturnValue(new DOMRect(100, 0, 40, 32));
  action?.update?.("second");
  flushFrame();
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0]![1]).toMatchObject({ pseudoElement: "::before" });
  expect(frames.size).toBe(0);
  animations[0]!.onfinish?.();
  expect(node.style.getPropertyValue("--selection-x")).toBe("100px");
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  action?.destroy?.();
});

it("快速反向从浏览器当前时刻续接，尺寸变化与减少动态效果立即对齐", () => {
  const action = selectionIndicator(node, "first");
  flushFrame();
  vi.mocked(selected.getBoundingClientRect).mockReturnValue(new DOMRect(100, 0, 40, 32));
  action?.update?.("second");
  flushFrame();
  expect(animations).toHaveLength(1);
  animations[0]!.currentTime = 80;
  vi.mocked(selected.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 40, 32));
  action?.update?.("first");
  flushFrame();
  const keyframes: Keyframe[] = animate.mock.calls[1]![0];
  const origin = Number.parseFloat(String(keyframes[0]!.translate));
  expect(origin).toBeGreaterThan(0);
  expect(origin).toBeLessThan(100);
  expect(Number.parseFloat(String(keyframes[1]!.translate))).toBeGreaterThan(origin);
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  resize([], { observe() {}, unobserve() {}, disconnect() {} });
  flushFrame();
  expect(animations[1]!.cancel).toHaveBeenCalledOnce();
  expect(node.style.getPropertyValue("--selection-x")).toBe("0px");
  vi.mocked(selected.getBoundingClientRect).mockReturnValue(new DOMRect(100, 0, 40, 32));
  action?.update?.("second");
  flushFrame();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  flushFrame();
  expect(animations[2]!.cancel).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  action?.destroy?.();
  expect(node.hasAttribute("data-selection-ready")).toBe(false);
});
