/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  dialogEnter,
  dialogExit,
  finishOnReducedMotion,
} from "@reader/renderer/transition-lifecycle";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("模态立即关闭，DOM 存活期覆盖对话框和遮罩的退出时长", () => {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  vi.spyOn(window, "getComputedStyle").mockImplementation((_node, pseudo) => {
    const style = document.createElement("div").style;
    style.transitionDuration = pseudo ? "130ms, 0.15s" : "0.1s";
    return style;
  });
  expect(dialogExit(dialog).duration).toBe(150);
  expect(dialog.open).toBe(false);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(dialogExit(dialog).duration).toBe(0);
});

it("首次进入不抢在组件初始化前打开，取消退出重开时才恢复原生模态", () => {
  const dialog = document.createElement("dialog");
  const open = vi.fn(() => {
    dialog.open = true;
  });
  Object.defineProperty(dialog, "showModal", { value: open });
  expect(dialogEnter(dialog).duration).toBe(0);
  expect(open).not.toHaveBeenCalled();
  dialog.showModal();
  dialogEnter(dialog);
  expect(open).toHaveBeenCalledOnce();
  dialogExit(dialog);
  dialogEnter(dialog);
  expect(open).toHaveBeenCalledTimes(2);
});

it("系统偏好结束暂停的 Svelte 过渡，准备帧后的过渡也完成，卸载不留回调", async () => {
  const node = document.createElement("div");
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const finish = vi.fn();
  Object.defineProperty(node, "getAnimations", { value: () => [{ playState: "paused", finish }] });
  const action = finishOnReducedMotion(node);
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(finish).toHaveBeenCalledOnce();
  node.dispatchEvent(new Event("outrostart"));
  await Promise.resolve();
  expect(finish).toHaveBeenCalledTimes(2);
  node.dispatchEvent(new Event("introstart"));
  action?.destroy?.();
  await Promise.resolve();
  media.dispatchEvent(new Event("change"));
  expect(finish).toHaveBeenCalledTimes(2);
});
