/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ReadingFontOptions from "@app/ReadingFontOptions.svelte";
import type { AppApi } from "../../../../../modules/notes/packages/desktop/src/shared/api";

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const load = vi.fn(async () => []);
const api: Pick<AppApi, "readingFontGet" | "readingFontSet"> = {
  readingFontGet: vi.fn(async () => "newsreader"),
  readingFontSet: vi.fn(async () => {}),
};
const apply = vi.fn(async () => {});

async function start() {
  vi.clearAllMocks();
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  target = document.createElement("div");
  document.body.append(target);
  instance = mount(ReadingFontOptions, { target, props: { api, onApply: apply } });
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("fieldset")?.getAttribute("aria-busy")).toBe("false");
  });
}

function button(name: string): HTMLButtonElement {
  const element = target.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!element) throw new Error(`未找到字体：${name}`);
  return element;
}

afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  Reflect.deleteProperty(document, "fonts");
});

it("恢复精选字体；提交失败不改变显示，再次选择可以重试", async () => {
  await start();
  expect(apply).toHaveBeenLastCalledWith("newsreader");
  expect(target.querySelectorAll("button")).toHaveLength(3);
  expect(button("轻盈杂志").getAttribute("aria-pressed")).toBe("true");
  vi.mocked(api.readingFontSet).mockRejectedValueOnce(new Error("磁盘只读"));
  button("清晰现代").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("磁盘只读");
  });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(button("轻盈杂志").getAttribute("aria-pressed")).toBe("true");
  button("清晰现代").click();
  await vi.waitFor(() => {
    flushSync();
    expect(button("清晰现代").getAttribute("aria-pressed")).toBe("true");
  });
  expect(api.readingFontSet).toHaveBeenLastCalledWith("sans");
  expect(apply).toHaveBeenLastCalledWith("sans");
});

it("字体加载失败不写偏好，读取失败后默认项也可重新选择", async () => {
  vi.mocked(api.readingFontGet).mockRejectedValueOnce(new Error("读取失败"));
  await start();
  load.mockRejectedValueOnce(new Error("字形不可用"));
  button("温润书页").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("字形不可用");
  });
  expect(api.readingFontSet).not.toHaveBeenCalled();
  button("温润书页").click();
  await vi.waitFor(() => {
    flushSync();
    expect(apply).toHaveBeenCalledWith("lora");
  });
});

it("保存期间选项保持键盘焦点，但重复操作不能再次提交", async () => {
  await start();
  const saving = Promise.withResolvers<void>();
  vi.mocked(api.readingFontSet).mockReturnValueOnce(saving.promise);
  const modern = button("清晰现代");
  modern.focus();
  modern.click();
  await vi.waitFor(() => {
    flushSync();
    expect(api.readingFontSet).toHaveBeenCalledTimes(1);
    expect(modern.getAttribute("aria-disabled")).toBe("true");
  });
  modern.click();
  button("温润书页").click();
  expect(api.readingFontSet).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(modern);
  saving.resolve();
  await vi.waitFor(() => {
    flushSync();
    expect(modern.getAttribute("aria-pressed")).toBe("true");
    expect(modern.getAttribute("aria-disabled")).toBe("false");
  });
});
