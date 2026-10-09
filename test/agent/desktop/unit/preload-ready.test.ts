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

it("主进程业务失败去除 IPC 包装，保留原始错误作为原因", async () => {
  const api = createAgentApi();
  transport.ready();
  const original = new Error("Error invoking remote method 'agent.start': Error: 当前模型不支持图片");
  transport.invoke.mockRejectedValueOnce(original);
  await expect(api.start("conversation", "问题")).rejects.toMatchObject({
    message: "当前模型不支持图片", cause: original,
  });
});

it("非 IPC 包装错误原样传播，不改写未知异常", async () => {
  const api = createAgentApi();
  transport.ready();
  const original = new Error("连接断开");
  transport.invoke.mockRejectedValueOnce(original);
  await expect(api.list()).rejects.toBe(original);
});
