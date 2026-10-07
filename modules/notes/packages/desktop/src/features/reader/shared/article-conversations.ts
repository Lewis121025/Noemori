/** 阅读器只接收文章对话的预览投影，不接触模型配置、完整历史或原生运行资源。 */
export type ArticleConversationPreview = {
  id: string;
  title: string;
  workspace: string;
  archived: boolean;
  article: { path: string; title: string } | null;
  excerpt: string;
  /** 会话中的用户与助手文本，按原顺序展示；工具执行留在 Agent 工作区。 */
  messages: { role: "user" | "assistant"; text: string }[];
};
/** 外壳注入的文章对话能力；持久化与生命周期由提供者管理，错误向调用方传播。 */
export type ArticleAgentActions = {
  api: {
    attachVault(root: string): Promise<void>;
    list(): Promise<{ items: Omit<ArticleConversationPreview, "excerpt" | "messages">[] }>;
    createArticle(request: {
      root: string;
      path: string;
      title: string;
    }): Promise<ArticleConversationPreview>;
    snapshot(id: string): Promise<ArticleConversationPreview>;
    remove(id: string): Promise<void>;
    remapArticles(root: string, changes: { from: string; to: string | null }[]): Promise<void>;
    subscribe(callback: (id: string) => void): () => void;
  };
  open: (id: string | null, article: { root: string; path: string }) => Promise<void>;
};
/** 单个编辑器捕获所属文章后的能力；异步操作不得使用另一分栏的光标。 */
export type ArticleEditorActions = {
  create: (title: string) => Promise<ArticleConversationPreview>;
  discard: (id: string) => Promise<void>;
  preview: (id: string) => Promise<ArticleConversationPreview>;
  open: (id: string) => Promise<void>;
  report: (message: string) => void;
};

const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const prefix = "noemori://conversation/";

/** 读取应用内对话 URI；无效或外部链接返回 null，不抛错也不触发导航。 */
export function articleConversationId(href: string): string | null {
  const id = href.startsWith(prefix) ? href.slice(prefix.length) : "";
  return identifier.test(id) ? id : null;
}

/** 生成稳定的正文链接；无效身份抛错，禁止将路径或任意 URL 塞入标记。 */
export function articleConversationHref(id: string): string {
  if (!identifier.test(id)) throw new Error("对话标记无效");
  return `${prefix}${id}`;
}
