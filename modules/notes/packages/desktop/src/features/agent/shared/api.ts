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
/** 原生模型配置；能力由用户明确声明，不按模型名称推断。 */
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
/** 对话快照可在窗口重载后重新读取。 */
export type AgentSnapshot = {
  browser: AgentBrowser;
  id: string;
  workspace: string;
  revision: number;
  closed: boolean;
  run: {
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
  } | null;
  messages: AgentMessage[];
  terminals: AgentTerminal[];
  approvals: AgentApproval[];
};
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
  type: "terminal" | "network" | "browser";
  decision:
    | { decision: "allow_once" | "allow_for_session" }
    | { decision: "deny"; details: string }
    | { decision: "allow_prefix" | "allow_persistent_prefix"; details: { prefix: string[] } };
};
/** preload 暴露的固定动作，不提供任意主进程调用或原生句柄。 */
export type AgentApi = {
  browserControl(id: string, resume: boolean): Promise<void>;
  settingsGet(): Promise<PublicModelSettings | null>;
  settingsSet(settings: ModelSettingsUpdate): Promise<PublicModelSettings>;
  create(): Promise<AgentSnapshot | null>;
  list(): Promise<AgentSnapshot[]>;
  snapshot(id: string): Promise<AgentSnapshot>;
  start(id: string, text: string): Promise<string>;
  cancel(id: string): Promise<void>;
  close(id: string): Promise<void>;
  approve(id: string, approval: string, reply: ApprovalReply): Promise<void>;
  terminalRead(id: string, terminal: string, offset: string): Promise<TerminalPage>;
  terminalInput(id: string, terminal: string, data: Uint8Array): Promise<void>;
  terminalStop(id: string, terminal: string): Promise<void>;
  terminalAction(id: string, arguments_: unknown): Promise<unknown>;
  subscribe(callback: (id: string) => void): () => void;
};
