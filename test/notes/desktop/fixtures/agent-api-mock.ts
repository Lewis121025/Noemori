import type { AgentApi } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

/** 阅读器测试提供完整应用边界；意外调用有副作用的 Agent 方法时明确失败。 */
export function createAgentApiMock(): AgentApi {
  const unavailable = async (): Promise<never> => {
    throw new Error("此阅读器测试没有启动 Agent 会话");
  };
  return {
    settingsGet: async () => null,
    settingsSet: unavailable,
    create: unavailable,
    list: async () => [],
    snapshot: unavailable,
    start: unavailable,
    cancel: unavailable,
    close: unavailable,
    approve: unavailable,
    browserControl: unavailable,
    terminalRead: unavailable,
    terminalInput: unavailable,
    terminalStop: unavailable,
    terminalAction: unavailable,
    subscribe: () => () => {},
  };
}
