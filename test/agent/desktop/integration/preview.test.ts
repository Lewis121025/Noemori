/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import AgentPreview from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPreview.svelte";
import { parsePreviewTarget, parseBrowserHumanInput, previewPosition } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/preview";
import type { UiPreviewFrame } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("预览拒绝未知后端、非有限坐标与超限输入，窗口拖动始终留在可见范围", () => {
  for (const backend of ["chrome", "edge"])
    expect(parsePreviewTarget({ backend, page: "shared-page" })).toEqual({ backend, page: "shared-page" });
  expect(() => parsePreviewTarget({ backend: "shell" })).toThrow();
  expect(() => parseBrowserHumanInput({ type: "pointer", x: NaN, y: 1 })).toThrow();
  expect(() => parseBrowserHumanInput({ type: "text", text: "x".repeat(16385) })).toThrow();
  expect(previewPosition(900, -10, 640, 460, 1024, 768)).toEqual({ x: 376, y: 8 });
  expect(previewPosition(900, 900, 640, 460, 300, 200)).toEqual({ x: 8, y: 8 });
});

it("预览刷新不能清掉人工输入失败的提示", async () => {
  vi.useFakeTimers();
  const api = createAgentApiMock();
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "control" });
  api.browserInput = vi.fn().mockRejectedValue(new Error("输入未送达"));
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "managed", page: "page" }, title: "后台浏览器", human: true, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  document.querySelector<HTMLButtonElement>('[aria-label="输入文字"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const field = document.querySelector<HTMLInputElement>('[aria-label="向浏览器输入文字"]')!;
  field.value = "测试";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector(".agent-preview form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(document.querySelector(".agent-preview")?.textContent).toContain("输入未送达");
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  expect(document.querySelector(".agent-preview")?.textContent).toContain("输入未送达");
});

it("浮窗移出侧栏裁剪区域，预览不抢焦点，关闭后不再请求画面", async () => {
  vi.useFakeTimers();
  const editor = document.createElement("textarea");
  const target = document.createElement("div");
  document.body.append(editor, target);
  editor.focus();
  const api = createAgentApiMock();
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "control" });
  const close = vi.fn();
  const component = mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "managed", page: "page" }, title: "后台浏览器", close } });
  mounted.push(component);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(document.activeElement).toBe(editor);
  expect(document.body.querySelector('[role="dialog"]')?.parentElement).toBe(document.body);
  expect(document.querySelector<HTMLImageElement>(".agent-preview img")?.src).toContain("data:image/jpeg");
  document.querySelector<HTMLButtonElement>('[aria-label="放大画面"]')!.click();
  flushSync();
  expect(document.querySelector(".agent-preview")?.classList.contains("expanded")).toBe(true);
  document.querySelector<HTMLButtonElement>('[aria-label="关闭画面"]')!.click();
  expect(close).toHaveBeenCalledOnce();
  await unmount(component);
  mounted.pop();
  const count = vi.mocked(api.uiPreview).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.uiPreview).toHaveBeenCalledTimes(count);
  expect(document.querySelector(".agent-preview")).toBeNull();
});

it("预览请求保持串行，卸载后的迟到画面不创建新的轮询", async () => {
  vi.useFakeTimers();
  let resolve!: (value: UiPreviewFrame) => void;
  const api = createAgentApiMock();
  api.uiPreview = vi.fn(() => new Promise<UiPreviewFrame>((done) => { resolve = done; }));
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "managed", page: "page" }, title: "后台浏览器", close: () => {} } });
  flushSync();
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.uiPreview).toHaveBeenCalledOnce();
  await unmount(component);
  resolve({ image: "data:image/jpeg;base64,/9j/", inputToken: "control" });
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.uiPreview).toHaveBeenCalledOnce();
});

it("输入失败后停止已排队按键，远程键盘事件不触发主窗口快捷键", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<void>();
  const api = createAgentApiMock();
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "control" });
  api.browserInput = vi.fn(() => pending.promise);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "managed", page: "page" }, title: "后台浏览器", human: true, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const hostKey = vi.fn();
  document.body.addEventListener("keydown", hostKey);
  const screen = document.querySelector<HTMLButtonElement>('[aria-label="浏览器画面"]')!;
  for (const key of ["a", "b"])
    screen.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  pending.reject(new Error("输入失败"));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.browserInput).toHaveBeenCalledOnce();
  expect(hostKey).not.toHaveBeenCalled();
  document.body.removeEventListener("keydown", hostKey);
});

it("文字草稿与网页弹窗输入各自保存，清空 prompt 是有效回应", async () => {
  vi.useFakeTimers();
  const api = createAgentApiMock();
  api.uiPreview = vi.fn().mockResolvedValue({ image: null, inputToken: "control" });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "managed", page: "page" }, title: "后台浏览器", human: true, dialog: { type: "prompt", message: "姓名" }, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  document.querySelector<HTMLButtonElement>('[aria-label="输入文字"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const field = document.querySelector<HTMLInputElement>('[aria-label="向浏览器输入文字"]')!;
  field.value = "未提交的草稿";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(document.querySelector<HTMLInputElement>('[aria-label="网页对话框输入"]')!.value).toBe("");
  expect(parseBrowserHumanInput({ type: "dialog", accept: true, text: "" })).toEqual({ type: "dialog", accept: true, text: "" });
});
