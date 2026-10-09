import type { ArticleConversationRequest, ArticleLocation } from "./article";
import type {
  DiscoveredModel,
  ModelSelection,
  ProviderCatalog,
  ProviderConnection,
  ProviderUpdate,
} from "./providers";
import type { ReasoningEffort } from "./reasoning";
import type { ConversationQueue } from "./queue";
import type { AgentReference } from "./references";
import type { AgentAttachment, AttachmentPreview, AttachmentUpload } from "./attachments";
import type { LibraryEntriesDrag } from "../../reader/shared/file-drag";
/** Agent 的窗口协议只交付可见状态，认证材料由主进程单独持有。 */
export type Protocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "vertex-anthropic"
  | "gemini"
  | "ollama"
  | "bedrock";
/** 明确的请求认证，存储时由主进程加密。 */
export type Authentication =
  | { type: "none" }
  | { type: "bearer"; value: string }
  | { type: "header"; name: string; value: string }
  | {
      type: "aws";
      region: string;
      access_key: string;
      secret_key: string;
      session_token: string | null;
    };
/** 原生模型配置；能力来自接口或用户声明，不按模型名称推断。 */
export type ModelSettings = {
  protocol: Protocol;
  model: string;
  endpoint: string;
  authentication: Authentication;
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  reasoningEffort?: ReasoningEffort;
};
/** 设置读取不会返还密钥原文，空认证输入可以明确选择保留已有材料。 */
export type PublicModelSettings = Omit<ModelSettings, "authentication"> & {
  authentication: {
    type: Authentication["type"];
    configured: boolean;
    name: string;
    region: string;
  };
};
/** 保存设置时 null 仅保留当前已保存认证，不自行切换认证类型。 */
export type ModelSettingsUpdate = Omit<ModelSettings, "authentication"> & {
  authentication: Authentication | null;
};
/** 界面可见消息与工具参数；未完成参数不作为可执行调用。 */
export type MessagePart =
  | { type: "text" | "reasoning"; value: string }
  | { type: "tool_call"; value: { id: string; name: string; arguments: unknown } }
  | {
      type: "tool_result";
      value: { call_id: string; name: string; output: unknown; is_error: boolean };
    }
  | { type: "image" | "audio" | "video"; value: unknown };
/** 已观察到的消息，供应商原生签名不在协议中。 */
export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: MessagePart[];
};
/** 进程状态投影与原始日志读取独立；原生省略的未确定字段在解码边界统一为 null。 */
export type TerminalInfo = {
  session_id: string;
  status: "running" | "exited" | "stopped" | "timed_out" | "failed";
  exit_code: number | null;
  signal: string | null;
  error: string | null;
};
/** 终端记录不随快照复制全文。 */
export type AgentTerminal = {
  call_id: string;
  process: TerminalInfo;
  bytes: number;
  tty: boolean;
  error: string | null;
};
/** 文件和执行审批显示实际命令、目录与请求范围。 */
export type TerminalApproval = {
  type: "terminal";
  request: {
    command: string;
    workdir: string;
    shell: string;
    tty: boolean;
    stdin: boolean;
    login: boolean;
    permissions: {
      reason: string;
      readable_paths: string[];
      writable_paths: string[];
      network: boolean;
    };
  };
};
/** 网络审批限定单个主机、端口和传输协议。 */
export type NetworkApproval = {
  type: "network";
  request: {
    command: string;
    workdir: string;
    target: { host: string; port: number; protocol: "tcp" | "udp" };
  };
};
/** 每条等待使用原生生成的标识，不能用工具调用 ID 代替。 */
export type AgentApproval = {
  id: string;
  request:
    | TerminalApproval
    | NetworkApproval
    | {
        type: "ui";
        request: {
          app: string;
          window: string;
          reason: string;
          app_name: string;
          window_title: string;
        };
      }
    | { type: "browser"; request: { origin: string; reason: string } };
};
/** 浏览器状态来自 Rust 资源所有者；迟到回执不会随模型取消而丢失。 */
export type AgentBrowser = {
  status: "idle" | "starting" | "ready" | "busy" | "human" | "failed" | "closed";
  tabs: {
    id: string;
    url: string;
    title: string;
    crashed: boolean;
    file_chooser: boolean;
    dialog: { type: string; message: string } | null;
  }[];
  receipts: {
    call_id: string;
    action: string;
    outcome: "observed" | "executed" | "not_executed" | "unknown";
    error: string | null;
    steps: {
      index: number;
      action: string;
      outcome: "observed" | "executed" | "not_executed" | "unknown";
      error: string | null;
    }[];
  }[];
  error: string | null;
};
/** 一轮用户任务的身份与终态；同一轮可以发起多次模型调用。 */
export type AgentRun = {
  id: string;
  status:
    | "running"
    | "completed"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "truncated"
    | "filtered"
    | "failed";
  error: string | null;
  model_calls: number;
};
/** 可见轮次的消息范围为左闭右开区间，边界由原生历史提交时生成。 */
export type AgentTurn = { run: AgentRun; message_start: number; message_end: number };
/** 分支保留来源身份与名称；来源被删除也不丢失可读关系。 */
export type ConversationOrigin = { conversationId: string; title: string; turnId: string | null };
/** 分叉在确认名称后创建，null 表示复制当前完整历史。 */
export type ConversationForkRequest = { title: string; afterTurnId: string | null };
/** 对话快照可在窗口重载后重新读取。 */
export type AgentSnapshot = {
  ui: AgentUi;
  browser: AgentBrowser;
  id: string;
  workspace: string;
  revision: number;
  closed: boolean;
  run: AgentRun | null;
  turns: AgentTurn[];
  messages: AgentMessage[];
  terminals: AgentTerminal[];
  approvals: AgentApproval[];
};

/** 界面执行与真实连接状态，重启和分叉不恢复这些资源。 */
export type AgentUi = {
  status: "idle" | "ready" | "busy" | "failed" | "closed";
  generation: number;
  call: string | null;
  error: string | null;
  connections: {
    id: string;
    backend: "chrome" | "edge" | "computer";
    name: string;
    connected: boolean;
    human: boolean;
    tabs: { id: string; title: string; url: string }[];
  }[];
  receipts: {
    id: string;
    backend: string;
    action: string;
    outcome: "observed" | "executed" | "not_executed" | "unknown";
    pending: boolean;
    error: string | null;
  }[];
  control: {
    app: string;
    window: string;
    reason: string;
    app_name: string;
    window_title: string;
  } | null;
};
/** 加载扩展和识别原生 helper 所需安装信息，不包含连接密钥。 */
export type UiInstallation = {
  extensionDirectory: string;
  computerHelper: string | null;
  installed: boolean;
};
/** 系统权限只能由用户授予，检查返回当前实际状态。 */
export type UiPermissions = {
  accessibility: boolean;
  screen_recording: boolean;
  input_monitoring: boolean;
};

/** 浮窗只能查看当前会话已经打开的页面或已批准的应用窗口。 */
export type UiPreviewTarget =
  | { backend: "managed" | "chrome" | "edge"; page: string }
  | { backend: "computer"; app: string; window: string };
/** 一次独立预览；图像与接管凭据一起交付，弹窗阻止截图时图像为空。 */
export type UiPreviewFrame = { image: string | null; inputToken: string | null };
/** 人工接管后的浏览器输入；坐标使用原始画面像素，缩放不会改变页面视口。 */
export type BrowserHumanInput =
  | { type: "dialog"; accept: boolean; text?: string }
  | { type: "files"; paths: string[] }
  | { type: "pointer"; x: number; y: number }
  | { type: "scroll"; x: number; y: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

/** 会话列表只传摘要，完整消息按选中的会话读取。时间采用 Unix 毫秒。 */
export type AgentConversationInfo = {
  id: string;
  title: string;
  /** 用户选择的目录关联；null 表示独立对话，不暴露内部运行目录。 */
  workspace: string | null;
  model: string;
  modelSelection: ModelSelection | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  origin: ConversationOrigin | null;
  article: ArticleLocation | null;
  status: NonNullable<AgentSnapshot["run"]>["status"] | null;
};
/** 持久化对话与当前资源状态；草稿属于单条会话，保存失败必须明确展示。 */
export type AgentConversation = Omit<AgentSnapshot, "workspace"> &
  Omit<AgentConversationInfo, "status"> & {
    draft: string;
    /** 显式引用随草稿保存；省略表示没有引用。 */
    draftReferences?: AgentReference[];
    /** 未发送附件由对话独立保存，读取快照不激活模型。 */
    draftAttachments?: AgentAttachment[];
    storageError: string | null;
  };
/** 单条损坏记录不会阻断其余会话；issues 保留恢复失败的文件及原因。 */
export type AgentConversationList = { items: AgentConversationInfo[]; issues: string[] };
/** 原始日志页，不消费模型的增量输出。 */
export type TerminalPage = {
  process: TerminalInfo;
  chunks: {
    stream: "stdout" | "stderr" | "terminal";
    data_base64: string;
    offset: number;
    next_offset: number;
  }[];
  offset: number;
  next_offset: number;
  total_bytes: number;
  has_more: boolean;
};
/** 窗口明确提交已有申请的决定；前缀决定由界面确认完整参数向量。 */
export type ApprovalReply = {
  type: "terminal" | "network" | "browser" | "ui";
  decision:
    | { decision: "allow_once" | "allow_for_session" }
    | { decision: "deny"; details: string }
    | { decision: "allow_prefix" | "allow_persistent_prefix"; details: { prefix: string[] } };
};
/** preload 暴露的固定动作，不提供任意主进程调用或原生句柄。 */
export type AgentApi = {
  /** 独立预览不改变模型观察，目标关闭或失效时拒绝。 */
  uiPreview(id: string, target: UiPreviewTarget): Promise<UiPreviewFrame>;
  /** 未接管时拒绝人工输入，不触发模型运行。 */
  browserInput(id: string, page: string, token: string, input: BrowserHumanInput): Promise<void>;
  /** 用户选择工作区文件后交给待处理上传控件；取消时清空选择。 */
  browserChooseFiles(id: string, page: string, token: string): Promise<void>;
  uiControl(
    id: string,
    backend: "managed" | "chrome" | "edge" | "computer",
    resume: boolean,
  ): Promise<void>;
  uiSetup(): Promise<UiInstallation>;
  uiPermissions(id: string): Promise<UiPermissions>;
  browserControl(id: string, resume: boolean): Promise<void>;
  settingsGet(id: string): Promise<PublicModelSettings | null>;
  providersGet(): Promise<ProviderCatalog>;
  /** 发现模型及接口报告的能力；认证原文只发给主进程，不随结果返回。 */
  providersDiscover(connection: ProviderConnection): Promise<DiscoveredModel[]>;
  /** 读取已保存连接的模型目录；请求期间连接改变则拒绝迟到结果。 */
  providersRefresh(id: string): Promise<ProviderCatalog>;
  providersSave(settings: ProviderUpdate): Promise<ProviderCatalog>;
  providersRemove(id: string): Promise<ProviderCatalog>;
  /** 只修改指定对话下一轮的模型，不改变运行中的配置或其他对话。 */
  modelSelect(id: string, selection: ModelSelection): Promise<ModelSelection>;
  pickWorkspace(): Promise<string | null>;
  /** 系统选择器导入不可变副本；取消返回空列表，不运行模型。 */
  attachmentsChoose(id: string): Promise<AgentAttachment[]>;
  /** 拖拽和粘贴提供已读取字节，仍经过主进程的归属与大小校验。 */
  attachmentsUpload(id: string, files: AttachmentUpload[]): Promise<AgentAttachment[]>;
  /** 复制当前笔记库中的文件；越界、文件夹、切库和超限通过 Promise 拒绝，不移动原文件。 */
  attachmentsFromLibrary(id: string, source: LibraryEntriesDrag): Promise<AgentAttachment[]>;
  /** 只预览本对话拥有的附件，不能把任意路径作为身份。 */
  attachmentPreview(id: string, attachmentId: string): Promise<AttachmentPreview>;
  /** 用户明确打开时由系统查看私有副本，失败原样报告。 */
  attachmentOpen(id: string, attachmentId: string): Promise<void>;
  /** 目录关联可选；null 创建独立对话，运行目录由主进程管理。 */
  create(workspace: string | null, title: string): Promise<AgentConversation>;
  /** 加载已打开笔记库中的文章对话；无记录时不创建目录。 */
  attachVault(root: string): Promise<void>;
  createArticle(request: ArticleConversationRequest): Promise<AgentConversation>;
  /** 文件操作完成后更新文章归属；删除入口或文章不会删除对话。 */
  remapArticles(root: string, changes: { from: string; to: string | null }[]): Promise<void>;
  fork(id: string, request: ConversationForkRequest): Promise<AgentConversation>;
  list(): Promise<AgentConversationList>;
  snapshot(id: string): Promise<AgentConversation>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  /** 只更新文字时缺省附件列表以保留异步导入结果；显式空列表才移除全部草稿附件。 */
  saveDraft(id: string, draft: string, references?: AgentReference[], attachments?: string[]): Promise<void>;
  flush(): Promise<void>;
  start(id: string, text: string, references?: AgentReference[], attachments?: string[]): Promise<string>;
  /** 中断指定运行，只有终态结算后兑现；迟到的旧运行编号会被拒绝。 */
  cancel(id: string, runId: string): Promise<void>;
  /** 明确继续最近未完成的任务，保留草稿；返回新运行编号。 */
  resume(id: string, runId: string): Promise<string>;
  /** 补充指定的当前任务，下一次模型请求使用该文字；返回原任务编号。 */
  steer(id: string, runId: string, text: string, references?: AgentReference[], attachments?: string[]): Promise<string>;
  /** 读取对话持有的追问队列，不恢复或启动任务。 */
  queueGet(id: string): Promise<ConversationQueue>;
  /** 保存下一轮追问；匹配已保存草稿时才清空草稿。 */
  queueAdd(id: string, runId: string, text: string, references?: AgentReference[], attachments?: string[]): Promise<ConversationQueue>;
  /** 用户明确移除未发送追问，不停止已经开始的任务。 */
  queueRemove(id: string, messageId: string): Promise<ConversationQueue>;
  /** 暂停队列，或明确继续发送；发送结果未确认的条目不能自动重发。 */
  queuePause(id: string, paused: boolean): Promise<ConversationQueue>;
  approve(id: string, approval: string, reply: ApprovalReply): Promise<void>;
  terminalRead(id: string, terminal: string, offset: string): Promise<TerminalPage>;
  terminalInput(id: string, terminal: string, data: Uint8Array): Promise<void>;
  terminalStop(id: string, terminal: string): Promise<void>;
  terminalAction(id: string, arguments_: unknown): Promise<unknown>;
  subscribe(callback: (id: string) => void): () => void;
};
