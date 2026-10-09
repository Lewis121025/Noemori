import { record, text, boolean, integer, nullableText, array } from "./values";
export { record, text, boolean, integer } from "./values";
import { parseUi } from "./ui";
import type {
  AgentApproval,
  AgentRun,
  AgentTurn,
  AgentMessage,
  AgentSnapshot,
  AgentTerminal,
  ApprovalReply,
  Authentication,
  MessagePart,
  ModelSettingsUpdate,
  Protocol,
  PublicModelSettings,
  TerminalInfo,
  TerminalPage,
} from "./api";

// Rust TerminalInfo 的未确定字段会省略；在协议解码边界投影为窗口 API 声明的 null。
function optionalText(value: Record<string, unknown>, key: string): string | null {
  return value[key] === undefined ? null : nullableText(value, key);
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
  if (type === "ui")
    return {
      id: text(item, "id"),
      request: {
        type,
        request: {
          app: text(details, "app"),
          window: text(details, "window"),
          reason: text(details, "reason"),
          app_name: text(details, "app_name"),
          window_title: text(details, "window_title"),
        },
      },
    };
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

function parseRun(value: unknown): AgentRun {
  const item = record(value);
  const status = text(item, "status");
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
  return {
    id: text(item, "id"),
    status,
    error: nullableText(item, "error"),
    model_calls: integer(item, "model_calls"),
  };
}

/** 从原生 JSON 恢复完整可见投影；未知状态或不闭合的轮次边界明确报错。 */
export function parseSnapshot(serialized: string): AgentSnapshot {
  const item = record(JSON.parse(serialized));
  const run = item["run"] === null ? null : parseRun(item["run"]);
  const messages = array(item["messages"]).map(message);
  let end: number | null = null;
  const identities = new Set<string>();
  const turns = array(item["turns"]).map((value): AgentTurn => {
    const turn = record(value);
    const result = {
      run: parseRun(turn["run"]),
      message_start: integer(turn, "message_start"),
      message_end: integer(turn, "message_end"),
    };
    if (
      identities.has(result.run.id) ||
      result.message_start >= result.message_end ||
      result.message_end > messages.length ||
      messages[result.message_start]?.role !== "user" ||
      (end !== null && end !== result.message_start)
    )
      throw new Error("Agent 轮次边界无效");
    identities.add(result.run.id);
    end = result.message_end;
    return result;
  });
  const last = turns.at(-1);
  if (
    last &&
    (last.message_end !== messages.length ||
      last.run.id !== run?.id ||
      last.run.status !== run.status)
  )
    throw new Error("Agent 末轮与当前运行不一致");
  return {
    browser: parseBrowser(item["browser"]),
    ui: parseUi(item["ui"]),
    id: text(item, "id"),
    workspace: text(item, "workspace"),
    revision: integer(item, "revision"),
    closed: boolean(item, "closed"),
    run,
    turns,
    messages,
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

/**
 * 验证 IPC 与解密边界共用的认证契约，不接受空凭据或不能传给原生 JSON 的文本。
 * @param value 未信任的认证对象；保留已有认证的 null 意图由配置更新入口处理。
 * @returns 仅包含该认证类型所需字段的独立对象。
 * @throws 类型、请求头名称、凭据内容或长度无效时拒绝。
 */
export function parseAuthentication(value: unknown): Authentication {
  const item = record(value);
  const type = text(item, "type");
  if (type === "none") return { type };
  if (type === "bearer") return { type, value: authenticationText(item, "value") };
  if (type === "header") {
    const name = text(item, "name");
    validateAuthenticationHeader(name);
    return { type, name, value: authenticationText(item, "value") };
  }
  if (type === "aws")
    return {
      type,
      region: authenticationText(item, "region"),
      access_key: authenticationText(item, "access_key"),
      secret_key: authenticationText(item, "secret_key"),
      session_token:
        item["session_token"] === null ? null : authenticationText(item, "session_token"),
    };
  throw new Error("请求认证类型无效");
}

function authenticationText(item: Record<string, unknown>, key: string): string {
  const value = text(item, key);
  if (!value.trim() || value.length > 32768 || /[\p{Control}\p{Surrogate}]/u.test(value))
    throw new Error("认证材料不能为空、超长或含非法字符");
  return value;
}

function validateAuthenticationHeader(name: string): void {
  if (name.length > 8192 || !/^[!#$%&'*+.^_`|~\w-]+$/u.test(name))
    throw new Error("认证请求头名称无效");
}

/**
 * 公开目录只验证认证描述，不触碰系统密钥；不相关字段必须为空以防掩盖类型混用。
 * @param value 磁盘或主进程提供的公开认证描述。
 * @returns 经过类型、状态和字段约束检查的描述。
 * @throws 描述类型、字段或配置状态互相矛盾时拒绝。
 */
export function parseAuthenticationDescription(
  value: unknown,
): PublicModelSettings["authentication"] {
  const item = record(value),
    type = text(item, "type");
  if (type !== "none" && type !== "bearer" && type !== "header" && type !== "aws")
    throw new Error("认证描述类型无效");
  const configured = boolean(item, "configured"),
    name = text(item, "name"),
    region = text(item, "region");
  if (
    configured !== (type !== "none") ||
    (type !== "header" && name !== "") ||
    (type !== "aws" && region !== "")
  )
    throw new Error("认证描述与类型不一致");
  if (type === "header") validateAuthenticationHeader(name);
  if (type === "aws") authenticationText(item, "region");
  return { type, configured, name, region };
}

/** 校验协议标识并返回原生支持的协议；未知标识抛出配置错误，不按品牌推断。 */
export function parseProtocol(value: string): Protocol {
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
    protocol: parseProtocol(text(item, "protocol")),
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
  if (type !== "terminal" && type !== "network" && type !== "browser" && type !== "ui")
    throw new Error("审批回复类型无效");
  const reply = record(item["decision"]);
  const decision = text(reply, "decision");
  if (
    (decision === "allow_once" && type !== "browser" && type !== "ui") ||
    decision === "allow_for_session"
  )
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
