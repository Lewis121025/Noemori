/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import AgentBrowser from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentBrowser.svelte";
import type { AgentBrowser as BrowserState } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const tab = { id: "page", native_target: "target", url: "https://example.com", title: "页面", crashed: false, file_chooser: false, dialog: null };
function fixture(status: BrowserState["status"] = "idle") {
  const api = Object.assign(createAgentApiMock(), {
    browserView: vi.fn().mockResolvedValue(undefined),
    browserControl: vi.fn(),
    browserNavigate: vi.fn(),
    uiPreview: vi.fn(),
  });
  const states = writable<BrowserState>({ status, tabs: [tab], receipts: [], error: null });
  const state = fromStore(states);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AgentBrowser, { target, props: { api, session: "conversation", get browser() { return state.current; } } }));
  flushSync();
  return { api, states };
}
it.each(["idle", "starting", "ready", "busy", "failed", "closed"] as const)("%s 状态不显示浏览器栏或自动打开新标签页", async (status) => {
  const { api } = fixture(status);
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.browserView).not.toHaveBeenCalled();
});
it("协助只显示真实网页小窗；结束与卸载只隐藏视图，不派发控制命令", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 60, 600, 300));
  const { api, states } = fixture();
  states.update((state) => ({ ...state, status: "human" }));
  flushSync();
  await vi.waitFor(() => expect(api.browserView).toHaveBeenLastCalledWith("conversation", {
    page: "page", human: true, bounds: { x: 20, y: 60, width: 600, height: 300 },
  }));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelectorAll("button, nav, form")).toHaveLength(0);
  expect(api.uiPreview).not.toHaveBeenCalled();
  states.update((state) => ({ ...state, status: "ready" }));
  flushSync();
  await vi.waitFor(() => expect(api.browserView).toHaveBeenLastCalledWith("conversation", null));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.browserControl).not.toHaveBeenCalled();
  expect(api.browserNavigate).not.toHaveBeenCalled();
});
it("画布无尺寸时隐藏原生网页，避免遮挡其他内容", async () => {
  let bounds = new DOMRect(20, 60, 600, 300);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds);
  const { api } = fixture("human");
  await vi.waitFor(() => expect(api.browserView).toHaveBeenCalled());
  bounds = new DOMRect();
  window.dispatchEvent(new Event("resize"));
  await vi.waitFor(() => expect(api.browserView).toHaveBeenLastCalledWith("conversation", null));
});
