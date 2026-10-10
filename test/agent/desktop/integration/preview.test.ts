/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import AgentPreview from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPreview.svelte";
import AgentUi from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentUi.svelte";
import { parsePreviewTarget, parseBrowserHumanInput, previewPosition } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/preview";
import type { UiPreviewFrame, UiPreviewTarget } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const mounted: ReturnType<typeof mount>[] = [];

it("组合输入期间同一窗口的画面凭据换代，旧文字不能沿用新凭据发送", async () => {
  vi.useFakeTimers();
  const api = createAgentApiMock();
  api.uiInput = vi.fn().mockResolvedValue(undefined);
  api.uiPreview = vi.fn()
    .mockResolvedValueOnce({ image: "data:image/jpeg;base64,/9j/", inputToken: "before-move" })
    .mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "after-move" });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", target: { backend: "computer", app: "app", window: "window" }, title: "窗口", human: true, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const keyboard = document.querySelector<HTMLTextAreaElement>('[aria-label="向画面输入"]')!;
  keyboard.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  keyboard.dispatchEvent(new CompositionEvent("compositionend", { data: "旧画面的文字", bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiInput).not.toHaveBeenCalled();
});

it("中文组合输入尚未完成时切换窗口，迟到文字不能进入新窗口", async () => {
  vi.useFakeTimers();
  const api = createAgentApiMock();
  api.uiInput = vi.fn().mockResolvedValue(undefined);
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "frame" });
  const targets = writable<UiPreviewTarget>({ backend: "computer", app: "app", window: "first" });
  const state = fromStore(targets);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", get target() { return state.current; }, title: "窗口", human: true, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const keyboard = document.querySelector<HTMLTextAreaElement>('[aria-label="向画面输入"]')!;
  keyboard.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  targets.set({ backend: "computer", app: "app", window: "second" });
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  keyboard.dispatchEvent(new CompositionEvent("compositionend", { data: "旧窗口的文字", bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiInput).not.toHaveBeenCalled();
});

it("接管原生应用自动打开窗口内画面，并在画面内一次点击完成并继续", async () => {
  vi.useFakeTimers();
  const api = createAgentApiMock();
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "frame" });
  api.uiControl = vi.fn().mockResolvedValue(undefined);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentUi, { target, props: { api, session: "session", ui: {
    status: "ready", generation: 0, call: null, error: null, receipts: [],
    control: { app: "approved-app", window: "approved-window", app_name: "应用", window_title: "窗口", reason: "编辑" },
    connections: [{ id: "computer", backend: "computer", name: "应用", connected: true, human: true, tabs: [] }],
  } } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const panel = document.querySelector(".agent-preview");
  expect(panel).not.toBeNull();
  const finish = [...panel!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "完成并继续");
  expect(finish).toBeDefined();
  finish!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiControl).toHaveBeenCalledWith("session", "computer", true);
});

it("原生应用画面在窗口内转发点击、中文输入法与粘贴，保持同一控制凭据", async () => {
  vi.useFakeTimers();
  const api = Object.assign(createAgentApiMock(), { uiInput: vi.fn().mockResolvedValue(undefined) });
  api.uiPreview = vi.fn().mockResolvedValue({ image: "data:image/jpeg;base64,/9j/", inputToken: "native-control" });
  const target = document.createElement("div");
  document.body.append(target);
  const window = { backend: "computer" as const, app: "approved-app", window: "approved-window" };
  mounted.push(mount(AgentPreview, { target, props: { api, session: "session", target: window, title: "原生应用", human: true, close: () => {} } }));
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const image = document.querySelector<HTMLImageElement>(".agent-preview img")!;
  Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 500 } });
  image.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 510, bottom: 270, width: 500, height: 250, toJSON() {} });
  const screen = document.querySelector<HTMLButtonElement>('[aria-label="浏览器画面"]')!;
  for (const type of ["pointerdown", "pointerup"])
    screen.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { button: 0, pointerId: 1, clientX: 110, clientY: 70 }));
  screen.dispatchEvent(new MouseEvent("click", { clientX: 110, clientY: 70, detail: 1, bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiInput).toHaveBeenCalledWith("session", window, "native-control", { type: "pointer", x: 200, y: 100, button: "left", clicks: 1 });
  const keyboard = document.querySelector<HTMLTextAreaElement>('[aria-label="向画面输入"]');
  expect(keyboard).not.toBeNull();
  keyboard!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  keyboard!.dispatchEvent(new CompositionEvent("compositionend", { data: "中文输入", bubbles: true }));
  keyboard!.dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), { clipboardData: { getData: () => "粘贴内容" } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiInput).toHaveBeenCalledWith("session", window, "native-control", { type: "text", text: "中文输入" });
  expect(api.uiInput).toHaveBeenCalledWith("session", window, "native-control", { type: "text", text: "粘贴内容" });
  screen.dispatchEvent(new MouseEvent("click", { clientX: 110, clientY: 70, detail: 2, bubbles: true }));
  const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
  keyboard!.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  keyboard!.value = "a";
  keyboard!.dispatchEvent(new InputEvent("input", { data: "a", bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.uiInput).toHaveBeenCalledWith("session", window, "native-control", { type: "pointer", x: 200, y: 100, button: "left", clicks: 2 });
  expect(api.uiInput).toHaveBeenCalledWith("session", window, "native-control", { type: "text", text: "a" });
});

it("浮窗拖动只响应主按钮和起始指针，Escape 恢复位置并释放捕获", () => {
  vi.useFakeTimers();
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentPreview, { target, props: {
    api: createAgentApiMock(), session: "session", target: { backend: "managed", page: "page" },
    title: "后台浏览器", close: () => {},
  } }));
  flushSync();
  const window = document.querySelector<HTMLElement>(".agent-preview")!;
  const handle = document.querySelector<HTMLButtonElement>('[aria-label="拖动画面窗口"]')!;
  const origin = { left: window.style.left, top: window.style.top };
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  const pointer = (type: string, clientX: number, pointerId = 1, button = 0) => {
    handle.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      button, pointerId, clientX, clientY: 100,
    }));
    flushSync();
  };
  pointer("pointerdown", 300, 1, 2);
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
  pointer("pointerdown", 300);
  expect(document.activeElement).toBe(handle);
  pointer("pointermove", 200, 2);
  expect(window.style.left).toBe(origin.left);
  pointer("pointercancel", 200, 2);
  pointer("pointermove", 200);
  expect(window.style.left).not.toBe(origin.left);
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  flushSync();
  expect({ left: window.style.left, top: window.style.top }).toEqual(origin);
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  pointer("pointermove", 150);
  expect(window.style.left).toBe(origin.left);
});
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
