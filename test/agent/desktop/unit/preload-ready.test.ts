import { expect, it, vi } from "vitest";
import { createAgentApi } from "../../../../modules/notes/packages/desktop/src/features/agent/preload/api";
const transport = vi.hoisted(() => ({
  ready: () => {},
  invoke: vi.fn(async () => ({ items: [], issues: [] })),
}));
vi.mock("electron", () => ({ ipcRenderer: {
  invoke: transport.invoke,
  once: (channel: string, callback: () => void) => { if (channel === "agent.ready") transport.ready = callback; },
  on: vi.fn(), removeListener: vi.fn(),
} }));
it("每个新页面的 Agent 调用等待宿主就绪，后续调用共用已完成的握手", async () => {
  const api = createAgentApi();
  const pending = api.list();
  expect(transport.invoke).not.toHaveBeenCalled();
  transport.ready();
  await expect(pending).resolves.toEqual({ items: [], issues: [] });
  expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("agent.list");
  await api.snapshot("conversation");
  expect(transport.invoke).toHaveBeenLastCalledWith("agent.snapshot", "conversation");
  transport.invoke.mockClear();
  const reloaded = createAgentApi();
  const next = reloaded.list();
  expect(transport.invoke).not.toHaveBeenCalled();
  transport.ready(); await next;
  expect(transport.invoke).toHaveBeenCalledOnce();
});
