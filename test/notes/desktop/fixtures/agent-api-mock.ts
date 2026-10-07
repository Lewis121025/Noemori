import type { AgentApi } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

/** 阅读器测试提供完整应用边界；意外调用有副作用的 Agent 方法时明确失败。 */
export function createAgentApiMock(): AgentApi {
  const unavailable = async (): Promise<never> => {
    throw new Error("此阅读器测试没有启动 Agent 会话");
  };
  return {
    settingsGet: async () => null,
    providersGet: async () => ({ providers: [], active: null }),
    providersSave: unavailable,
    providersRemove: unavailable,
    modelSelect: unavailable,
    create: unavailable,
    attachVault: async () => {},
    createArticle: unavailable,
    remapArticles: async () => {},
    fork: unavailable,
    pickWorkspace: async () => null,
    list: async () => ({ items: [], issues: [] }),
    snapshot: unavailable,
    start: unavailable,
    cancel: unavailable,
    resume: unavailable,
    rename: unavailable,
    archive: unavailable,
    remove: unavailable,
    saveDraft: unavailable,
    flush: async () => {},
    approve: unavailable,
    browserControl: unavailable,
    terminalRead: unavailable,
    terminalInput: unavailable,
    terminalStop: unavailable,
    terminalAction: unavailable,
    subscribe: () => () => {},
  };
}
