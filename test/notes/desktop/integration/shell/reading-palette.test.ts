/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ReadingPaletteOptions from "@app/ReadingPaletteOptions.svelte";
import type { AppApi } from "../../../../../modules/notes/packages/desktop/src/shared/api";

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const api: Pick<AppApi, "readingPaletteGet" | "readingPaletteSet"> = {
  readingPaletteGet: vi.fn(async () => "green"),
  readingPaletteSet: vi.fn(async () => {}),
};
const apply = vi.fn();

async function start(): Promise<void> {
  vi.clearAllMocks();
  target = document.createElement("div");
  document.body.append(target);
  instance = mount(ReadingPaletteOptions, { target, props: { api, onApply: apply } });
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("fieldset")?.getAttribute("aria-busy")).toBe("false");
  });
}

function button(name: string): HTMLButtonElement {
  const element = target.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!element) throw new Error(`未找到配色：${name}`);
  return element;
}

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target?.remove();
});

it("只显示两种配色，恢复绿色，保存失败保留原显示并允许重试", async () => {
  await start();
  expect(target.querySelectorAll("button")).toHaveLength(2);
  expect(apply).toHaveBeenLastCalledWith("green");
  expect(button("绿色").getAttribute("aria-pressed")).toBe("true");
  vi.mocked(api.readingPaletteSet).mockRejectedValueOnce(new Error("磁盘只读"));
  button("黑白").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("磁盘只读");
  });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(button("绿色").getAttribute("aria-pressed")).toBe("true");
  button("黑白").click();
  await vi.waitFor(() => {
    flushSync();
    expect(button("黑白").getAttribute("aria-pressed")).toBe("true");
  });
  expect(api.readingPaletteSet).toHaveBeenLastCalledWith("monochrome");
  expect(apply).toHaveBeenLastCalledWith("monochrome");
});

it("读取失败时保持默认黑白，重新选择默认项可以恢复", async () => {
  vi.mocked(api.readingPaletteGet).mockRejectedValueOnce(new Error("读取失败"));
  await start();
  expect(button("黑白").getAttribute("aria-pressed")).toBe("true");
  expect(apply).not.toHaveBeenCalled();
  button("黑白").click();
  await vi.waitFor(() => {
    flushSync();
    expect(apply).toHaveBeenCalledWith("monochrome");
  });
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it("保存完成前不应用新配色，重复点击只提交一次且保留焦点", async () => {
  await start();
  const saving = Promise.withResolvers<void>();
  vi.mocked(api.readingPaletteSet).mockReturnValueOnce(saving.promise);
  const monochrome = button("黑白");
  monochrome.focus();
  monochrome.click();
  flushSync();
  expect(monochrome.getAttribute("aria-disabled")).toBe("true");
  expect(button("绿色").getAttribute("aria-pressed")).toBe("true");
  expect(apply).toHaveBeenCalledTimes(1);
  monochrome.click();
  button("绿色").click();
  expect(api.readingPaletteSet).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(monochrome);
  saving.resolve();
  await vi.waitFor(() => {
    flushSync();
    expect(monochrome.getAttribute("aria-pressed")).toBe("true");
    expect(monochrome.getAttribute("aria-disabled")).toBe("false");
  });
});

it("卸载后不应用迟到的保存结果", async () => {
  await start();
  const saving = Promise.withResolvers<void>();
  vi.mocked(api.readingPaletteSet).mockReturnValueOnce(saving.promise);
  button("黑白").click();
  if (!instance) throw new Error("配色控件尚未挂载");
  await unmount(instance);
  instance = undefined;
  saving.resolve();
  await saving.promise;
  await Promise.resolve();
  expect(apply).toHaveBeenCalledTimes(1);
});
