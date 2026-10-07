import type {
  AgentApproval,
  AgentMessage,
  AgentSnapshot,
  AgentTerminal,
  ApprovalReply,
  Authentication,
  MessagePart,
  ModelSettingsUpdate,
  Protocol,
  TerminalInfo,
  TerminalPage,
} from "./api";

/** 固定窗口协议的对象边界；数组、null 和非对象均被拒绝。 */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Agent 协议需要对象");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 读取已声明的字符串，缺失字段不会默认为空值。 */
export function text(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`Agent 字段 ${key} 需要字符串`);
  return result;
}
/** 布尔字段不接受字符串或数字代替。 */
export function boolean(value: Record<string, unknown>, key: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") throw new Error(`Agent 字段 ${key} 需要布尔值`);
  return result;
}
/** 非负整数保持 JS 安全整数边界。 */
export function integer(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new Error(`Agent 字段 ${key} 需要非负安全整数`);
  return result;
}
function nullableText(value: Record<string, unknown>, key: string): string | null {
  return value[key] === null ? null : text(value, key);
}
// Rust TerminalInfo 的未确定字段会省略；在协议解码边界投影为窗口 API 声明的 null。
function optionalText(value: Record<string, unknown>, key: string): string | null {
  return value[key] === undefined ? null : nullableText(value, key);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Agent 协议需要数组");
  return value;
}
function strings(value: unknown): string[] {
  return array(value).map((item) => {
    if (typeof item !== "string") throw new Error("Agent 路径需要字符串");
    return item;
  });
}

function process(value: unknown): TerminalInfo {
  const item = record(value);
  const status = text(item, "status");
  if (
    status !== "running" &&
    status !== "exited" &&
    status !== "stopped" &&
    status !== "timed_out" &&
    status !== "failed"
  )
    throw new Error("终端状态无效");
  const exit = item["exit_code"] ?? null;
  if (exit !== null && (typeof exit !== "number" || !Number.isSafeInteger(exit)))
    throw new Error("终端退出码无效");
  return {
    session_id: text(item, "session_id"),
    status,
    exit_code: exit,
    signal: optionalText(item, "signal"),
    error: optionalText(item, "error"),
  };
}
function part(value: unknown): MessagePart {
  const item = record(value);
  const type = text(item, "type");
  if (type === "text" || type === "reasoning") return { type, value: text(item, "value") };
  const payload = item["value"];
  if (type === "image" || type === "audio" || type === "video") return { type, value: payload };
  const details = record(payload);
  if (type === "tool_call")
    return {
      type,
      value: {
        id: text(details, "id"),
        name: text(details, "name"),
        arguments: details["arguments"],
      },
    };
  if (type === "tool_result")
    return {
      type,
      value: {
        call_id: text(details, "call_id"),
        name: text(details, "name"),
        output: details["output"],
        is_error: boolean(details, "is_error"),
      },
    };
  throw new Error("Agent 消息内容类型无效");
}
function message(value: unknown): AgentMessage {
  const item = record(value);
  const role = text(item, "role");
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system")
    throw new Error("Agent 消息来源无效");
  return { role, content: array(item["content"]).map(part) };
}
function terminal(value: unknown): AgentTerminal {
  const item = record(value);
  return {
    call_id: text(item, "call_id"),
    process: process(item["process"]),
    bytes: integer(item, "bytes"),
    tty: boolean(item, "tty"),
    error: nullableText(item, "error"),
  };
}
function approval(value: unknown): AgentApproval {
  const item = record(value);
  const request = record(item["request"]);
  const details = record(request["request"]);
  const type = text(request, "type");
  if (type === "browser")
    return {
      id: text(item, "id"),
      request: {
        type,
        request: { origin: text(details, "origin"), reason: text(details, "reason") },
      },
    };
  if (type === "terminal") {
    const permissions = record(details["permissions"]);
    return {
      id: text(item, "id"),
      request: {
        type,
        request: {
          command: text(details, "command"),
          workdir: text(details, "workdir"),
          shell: text(details, "shell"),
          tty: boolean(details, "tty"),
          stdin: boolean(details, "stdin"),
          login: boolean(details, "login"),
          permissions: {
            reason: text(permissions, "reason"),
            readable_paths: strings(permissions["readable_paths"]),
            writable_paths: strings(permissions["writable_paths"]),
            network: boolean(permissions, "network"),
          },
        },
      },
    };
  }
  if (type === "network") {
    const target = record(details["target"]);
    const protocol = text(target, "protocol");
    if (protocol !== "tcp" && protocol !== "udp") throw new Error("网络审批协议无效");
    const port = integer(target, "port");
    if (port < 1 || port > 65535) throw new Error("网络审批端口无效");
    return {
      id: text(item, "id"),
      request: {
        type,
        request: {
          command: text(details, "command"),
          workdir: text(details, "workdir"),
          target: { host: text(target, "host"), port, protocol },
        },
      },
    };
  }
  throw new Error("审批类型无效");
}

/** 从原生 JSON 恢复完整可见投影；未知状态明确报错，不伪装为完成。 */
export function parseSnapshot(serialized: string): AgentSnapshot {
  const item = record(JSON.parse(serialized));
  let run: AgentSnapshot["run"] = null;
  if (item["run"] !== null) {
    const value = record(item["run"]);
    const status = text(value, "status");
    if (
      status !== "running" &&
      status !== "completed" &&
      status !== "cancelled" &&
      status !== "timed_out" &&
      status !== "budget_exhausted" &&
      status !== "truncated" &&
      status !== "filtered" &&
      status !== "failed"
    )
      throw new Error("Agent 运行状态无效");
    run = {
      id: text(value, "id"),
      status,
      error: nullableText(value, "error"),
      model_calls: integer(value, "model_calls"),
    };
  }
  return {
    browser: parseBrowser(item["browser"]),
    id: text(item, "id"),
    workspace: text(item, "workspace"),
    revision: integer(item, "revision"),
    closed: boolean(item, "closed"),
    run,
    messages: array(item["messages"]).map(message),
    terminals: array(item["terminals"]).map(terminal),
    approvals: array(item["approvals"]).map(approval),
  };
}

/** 浏览器状态逐字段恢复，未知执行阶段不能被界面当作操作成功。 */
function parseBrowser(value: unknown): AgentSnapshot["browser"] {
  const item = record(value);
  const status = text(item, "status");
  if (
    status !== "idle" &&
    status !== "starting" &&
    status !== "ready" &&
    status !== "busy" &&
    status !== "human" &&
    status !== "failed" &&
    status !== "closed"
  )
    throw new Error("浏览器状态无效");
  return {
    status,
    error: nullableText(item, "error"),
    tabs: array(item["tabs"]).map((value) => {
      const tab = record(value);
      const dialog = tab["dialog"] === null ? null : record(tab["dialog"]);
      return {
        id: text(tab, "id"),
        url: text(tab, "url"),
        title: text(tab, "title"),
        crashed: boolean(tab, "crashed"),
        file_chooser: boolean(tab, "file_chooser"),
        dialog:
          dialog === null ? null : { type: text(dialog, "type"), message: text(dialog, "message") },
      };
    }),
    receipts: array(item["receipts"]).map((value) => {
      const receipt = record(value);
      const outcome = browserOutcome(receipt);
      return {
        call_id: text(receipt, "call_id"),
        action: text(receipt, "action"),
        outcome,
        error: nullableText(receipt, "error"),
        steps: (receipt["steps"] === undefined ? [] : array(receipt["steps"])).map((value) => {
          const step = record(value);
          return {
            index: integer(step, "index"),
            action: text(step, "action"),
            outcome: browserOutcome(step),
            error: step["error"] === undefined ? null : nullableText(step, "error"),
          };
        }),
      };
    }),
  };
}

function browserOutcome(
  value: Record<string, unknown>,
): AgentSnapshot["browser"]["receipts"][number]["outcome"] {
  const outcome = text(value, "outcome");
  if (
    outcome !== "observed" &&
    outcome !== "executed" &&
    outcome !== "not_executed" &&
    outcome !== "unknown"
  )
    throw new Error("浏览器执行阶段无效");
  return outcome;
}

/** 原生日志页的进程状态是扁平字段；投影为窗口对象并校验独立游标，Base64 正文保留给终端解码。 */
export function parseTerminalPage(serialized: string): TerminalPage {
  const item = record(JSON.parse(serialized));
  return {
    process: process(item),
    offset: integer(item, "offset"),
    next_offset: integer(item, "next_offset"),
    total_bytes: integer(item, "total_bytes"),
    has_more: boolean(item, "has_more"),
    chunks: array(item["chunks"]).map((value) => {
      const chunk = record(value);
      const stream = text(chunk, "stream");
      if (stream !== "stdout" && stream !== "stderr" && stream !== "terminal")
        throw new Error("终端流来源无效");
      return {
        stream,
        data_base64: text(chunk, "data_base64"),
        offset: integer(chunk, "offset"),
        next_offset: integer(chunk, "next_offset"),
      };
    }),
  };
}

/** 认证采用明确类型，空值仅表示保留已有材料。 */
export function parseAuthentication(value: unknown): Authentication {
  const item = record(value);
  const type = text(item, "type");
  if (type === "none") return { type };
  if (type === "bearer") return { type, value: text(item, "value") };
  if (type === "header") return { type, name: text(item, "name"), value: text(item, "value") };
  if (type === "aws")
    return {
      type,
      region: text(item, "region"),
      access_key: text(item, "access_key"),
      secret_key: text(item, "secret_key"),
      session_token: nullableText(item, "session_token"),
    };
  throw new Error("请求认证类型无效");
}
function protocol(value: string): Protocol {
  if (
    value === "openai-chat" ||
    value === "openai-responses" ||
    value === "anthropic" ||
    value === "vertex-anthropic" ||
    value === "gemini" ||
    value === "ollama" ||
    value === "bedrock"
  )
    return value;
  throw new Error("模型协议无效");
}
/** 设置请求通过字段及 URL 检查后才进入加密存储。 */
export function parseModelSettings(value: unknown): ModelSettingsUpdate {
  const item = record(value);
  const endpoint = text(item, "endpoint");
  const model = text(item, "model");
  if (model.trim() === "" || model.length > 8192 || endpoint.length > 8192)
    throw new Error("模型或接口地址无效");
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "")
    throw new Error("模型接口必须是无内嵌凭据的 HTTP(S) 地址");
  return {
    protocol: protocol(text(item, "protocol")),
    model,
    endpoint,
    authentication:
      item["authentication"] === null ? null : parseAuthentication(item["authentication"]),
    tools: boolean(item, "tools"),
    streaming: boolean(item, "streaming"),
    vision: boolean(item, "vision"),
    audio: boolean(item, "audio"),
    video: boolean(item, "video"),
  };
}

/** 回复只包含原生支持的决定，前缀仍在 Rust 按实际命令验证。 */
export function parseApprovalReply(value: unknown): ApprovalReply {
  const item = record(value);
  const type = text(item, "type");
  if (type !== "terminal" && type !== "network" && type !== "browser")
    throw new Error("审批回复类型无效");
  const reply = record(item["decision"]);
  const decision = text(reply, "decision");
  if ((decision === "allow_once" && type !== "browser") || decision === "allow_for_session")
    return { type, decision: { decision } };
  if (decision === "deny") return { type, decision: { decision, details: text(reply, "details") } };
  if (
    (decision === "allow_prefix" || decision === "allow_persistent_prefix") &&
    type === "terminal"
  ) {
    const details = record(reply["details"]);
    const prefix = strings(details["prefix"]);
    if (
      prefix.length < 1 ||
      prefix.length > 32 ||
      prefix.some((word) => word.length > 8192 || word.includes("\0"))
    )
      throw new Error("审批前缀无效");
    return { type, decision: { decision, details: { prefix } } };
  }
  throw new Error("审批决定无效");
}
