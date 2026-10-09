/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { interactionFeedback, revealOnChange } from "@reader/renderer/motion";

type TestAnimation = { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null };
let host: HTMLDivElement;
let button: HTMLButtonElement;
let media: EventTarget & { matches: boolean };
let animations: TestAnimation[];
let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  button = document.createElement("button");
  button.style.setProperty("--motion-fast", "120ms");
  button.style.setProperty("--motion-enter", "220ms");
  button.style.setProperty("--motion-scene", "180ms");
  host.append(button);
  document.body.append(host);
  media = Object.assign(new EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  animations = [];
  animate = vi.fn(() => {
    const animation: TestAnimation = { cancel: vi.fn(), onfinish: null };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(button, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

it("重复点击替换旧反馈，结束和卸载都释放动画与监听", () => {
  const action = interactionFeedback(host);
  button.click();
  button.click();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  expect(animations[0]!.onfinish).toBeNull();
  animations[1]!.onfinish?.();
  expect(animations[1]!.cancel).toHaveBeenCalledOnce();
  button.click();
  action?.destroy?.();
  expect(animations[2]!.cancel).toHaveBeenCalledOnce();
  button.click();
  expect(animate).toHaveBeenCalledTimes(3);
});

it("隐藏与语义禁用的控件不播放反馈，也不拦截业务点击", () => {
  const action = interactionFeedback(host);
  const clicked = vi.fn();
  button.addEventListener("click", clicked);
  button.setAttribute("aria-disabled", "true");
  button.click();
  button.removeAttribute("aria-disabled");
  host.hidden = true;
  button.click();
  host.hidden = false;
  host.setAttribute("inert", "");
  button.click();
  expect(animate).not.toHaveBeenCalled();
  expect(clicked).toHaveBeenCalledTimes(3);
  action?.destroy?.();
});

it("指针释放不再追加透明度闪烁，按压反馈由实际按下状态承担", () => {
  const action = interactionFeedback(host);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(animate).not.toHaveBeenCalled();
  action?.destroy?.();
});

it("键盘激活只提示控件边界，不改变文字透明度或缩放", () => {
  const action = interactionFeedback(host);
  button.click();
  const frames: Keyframe[] = animate.mock.calls[0]![0];
  expect(frames.every((frame) => frame.opacity === undefined && frame.scale === undefined)).toBe(
    true,
  );
  action?.destroy?.();
});

it("相同展示标识不播放，快速更新保持同一节点且不抢焦点", async () => {
  const action = revealOnChange(button, { key: "a.md", kind: "document" });
  button.focus();
  action?.update?.({ key: "a.md", kind: "document" });
  await tick();
  expect(animate).not.toHaveBeenCalled();
  action?.update?.({ key: "b.md", kind: "document" });
  await tick();
  action?.update?.({ key: "c.md", kind: "document" });
  await tick();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(button);
  action?.destroy?.();
});

it("正文交接保留宿主的透明度，不给文字附加位移或缩放", async () => {
  button.style.opacity = "0.6";
  const action = revealOnChange(button, { key: "a.md", kind: "document" });
  action?.update?.({ key: "b.md", kind: "document" });
  await tick();
  const frames: Keyframe[] = animate.mock.calls[0]![0];
  expect(frames.at(-1)?.opacity).toBe(0.6);
  expect(frames.every((frame) => frame.translate === undefined && frame.scale === undefined)).toBe(
    true,
  );
  action?.destroy?.();
});

it("系统减少动态效果在播放中改变时立即取消，恢复后只响应新状态", async () => {
  const action = revealOnChange(button, { key: 0, kind: "preview" });
  action?.update?.({ key: 1, kind: "preview" });
  await tick();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  action?.update?.({ key: 2, kind: "preview" });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  action?.update?.({ key: 2, kind: "preview" });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  action?.update?.({ key: 3, kind: "preview" });
  await tick();
  expect(animate).toHaveBeenCalledTimes(2);
  action?.destroy?.();
});

it("隐藏或 inert 的辅助内容不启动动画，重新显露时只响应最新内容", async () => {
  const action = revealOnChange(button, { key: 0, kind: "panel" });
  host.hidden = true;
  action?.update?.({ key: 1, kind: "panel" });
  await tick();
  host.hidden = false;
  host.setAttribute("inert", "");
  action?.update?.({ key: 2, kind: "panel" });
  await tick();
  expect(animate).not.toHaveBeenCalled();
  host.removeAttribute("inert");
  action?.update?.({ key: 3, kind: "panel" });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  action?.destroy?.();
});

it("导航按前后关系进入，快速切换承接呈现位置且不移动焦点", async () => {
  const action = revealOnChange(button, { key: "files", kind: "navigation", direction: -1 });
  button.focus();
  action?.update?.({ key: "outline", kind: "navigation", direction: 1 });
  await tick();
  expect(animate.mock.calls[0]![0][0].translate).toBe("8px 0");
  button.style.translate = "3px 0";
  action?.update?.({ key: "files", kind: "navigation", direction: -1 });
  await tick();
  expect(animate.mock.calls[1]![0][0].translate).toBe("3px 0");
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(button);
  action?.destroy?.();
});

it("同轮内容更新只揭示最新状态，卸载后不播放待提交动画", async () => {
  const action = revealOnChange(button, { key: 0, kind: "panel" });
  action?.update?.({ key: 1, kind: "panel" });
  action?.update?.({ key: 2, kind: "panel" });
  await tick();
  expect(animate).toHaveBeenCalledOnce();
  action?.update?.({ key: 3, kind: "panel" });
  action?.destroy?.();
  await tick();
  expect(animate).toHaveBeenCalledOnce();
});
