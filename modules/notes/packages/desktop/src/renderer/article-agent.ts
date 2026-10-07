import type { AgentApi, AgentConversation } from "../features/agent/shared/api";
import type {
  ArticleAgentActions,
  ArticleConversationPreview,
} from "../features/reader/shared/article-conversations";

/** 外壳连接两个功能边界；阅读器只得到预览内容，不依赖 Agent 的历史和运行协议。 */
export function createArticleAgentActions(
  api: AgentApi,
  open: ArticleAgentActions["open"],
): ArticleAgentActions {
  const preview = (item: AgentConversation): ArticleConversationPreview => ({
    id: item.id,
    title: item.title,
    workspace: item.workspace,
    archived: item.archived,
    article: item.article ? { path: item.article.path, title: item.article.title } : null,
    messages: item.messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.value] : []))
        .join("\n");
      return text ? [{ role: message.role, text }] : [];
    }),
    excerpt:
      item.messages
        .flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.value] : [])),
        )
        .at(-1)
        ?.slice(0, 240) ?? "还没有消息。打开后可以围绕这一段提问。",
  });
  return {
    open,
    api: {
      attachVault: (root) => api.attachVault(root),
      list: () => api.list(),
      createArticle: async (request) => preview(await api.createArticle(request)),
      snapshot: async (id) => preview(await api.snapshot(id)),
      remove: (id) => api.remove(id),
      remapArticles: (root, changes) => api.remapArticles(root, changes),
      subscribe: (callback) => api.subscribe(callback),
    },
  };
}
