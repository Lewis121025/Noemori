/** 目录只接收会话的导航投影；模型配置、消息及运行资源仍归 Agent 管理。 */
export type WorkspaceConversation = {
  id: string;
  title: string;
  workspace: string | null;
  archived: boolean;
  updatedAt: number;
  origin: { conversationId: string; title: string; turnId: string | null } | null;
  article: { path: string; title: string; status: string; removed?: boolean } | null;
  status: string | null;
};
/** 文件树通过明确动作访问对话；会话身份绝不作为文件操作路径。 */
export type WorkspaceConversations = {
  items: readonly WorkspaceConversation[];
  selected: string | null;
  open(id: string): Promise<void>;
  create(directory: string): Promise<void>;
  manage(id: string, action: "rename" | "archive" | "remove" | "fork" | "restore"): Promise<void>;
};
