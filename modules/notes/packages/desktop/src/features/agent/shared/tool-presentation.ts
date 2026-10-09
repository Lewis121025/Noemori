import type { AgentMessage, MessagePart } from "./api";

/** 工具调用只采用协议中已经接收完整的参数，不持有执行状态。 */
export type ToolCall = Extract<MessagePart, { type: "tool_call" }>["value"];
/** 工具结果与原调用按标识和名称关联，正文仍保留宿主返回的 JSON。 */
export type ToolResult = Extract<MessagePart, { type: "tool_result" }>["value"];
/** 执行记录只描述实际参数和回执；完整命令、脚本不因摘要而丢失。 */
export type ToolAction = { label: string; target: string; source: string; sourceLabel: string };
/** 展示层只提取已知工具的正文；原结果始终可检查，不推断未知工具字段的含义。 */
export type ToolOutput = {
  text: string;
  label: string;
  error: string | null;
  note: string | null;
  state: string;
  tone: "normal" | "error" | "warning";
  extracted: boolean;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const browserActions: Record<string, string> = {
  open: "打开网页", navigate: "打开网页", read: "读取网页", observe: "查看页面",
  click: "点击页面", fill: "填写表单", select: "选择选项", check: "设置勾选",
  press: "按下按键", type: "输入文字", scroll: "滚动页面", find: "查找页面内容",
  screenshot: "查看页面画面", tabs: "查看标签页", close: "关闭页面", reload: "刷新页面",
  back: "返回上一页", forward: "前进到下一页", request_access: "申请网页访问",
};
const terminalActions: Record<string, string> = {
  interact: "读取命令输出", read: "读取命令输出", read_bytes: "读取命令输出",
  write: "发送进程输入", stop: "停止进程", interrupt: "中断进程",
  list: "查看进程", release: "释放进程记录", resize: "调整终端尺寸",
};
const computerActions: Record<string, string> = {
  apps: "查看应用", windows: "查看应用窗口", observe: "查看窗口内容", screenshot: "查看窗口画面",
  press: "点击应用控件", set_value: "填写应用控件", perform: "操作应用控件",
  request_control: "申请应用控制", pointer: "点击应用窗口", drag: "拖动窗口内容",
  type: "输入文字", key: "按下按键", scroll: "滚动窗口", permissions: "检查系统权限",
};

// 只识别不含展开、控制运算符或多行脚本的字面参数；复杂 shell 保留完整命令，不猜测目的。
function literalWords(command: string): string[] | null {
  if (/[\r\n]/u.test(command)) return null;
  const words: string[] = [];
  let remaining = command.trim();
  while (remaining) {
    const match = /^(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"\\`$;&|<>()#]+))(?:\s+|$)/u.exec(remaining);
    if (!match) return null;
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
    remaining = remaining.slice(match[0].length);
  }
  return words;
}

function commandAction(command: string): Pick<ToolAction, "label" | "target"> {
  const words = literalWords(command);
  if (words?.[0] === "cat" && words.length > 1 && words.slice(1).every((word) => word && !word.startsWith("-")))
    return { label: "读取文件", target: words.slice(1).join("、") };
  if (words?.[0] === "sed" && words.length === 4 && words[1] === "-n" && /^\d+(?:,\d+)?p$/u.test(words[2] ?? ""))
    return { label: "读取文件", target: words[3] ?? "" };
  if (words?.[0] === "ls" && words.slice(1).every((word) => !word.startsWith("-") || /^-[alh1]+$/u.test(word)))
    return { label: "列出目录", target: words.slice(1).filter((word) => !word.startsWith("-")).join("、") || "." };
  if (words?.[0] === "rg") {
    if (words[1] === "--files" && words.slice(2).every((word) => !word.startsWith("-"))) return { label: "查找文件", target: words.slice(2).join(" ") || "." };
    const patternIndex = words[1] === "-n" ? 2 : 1;
    const pattern = words[patternIndex];
    if (pattern && !pattern.startsWith("-") && words.slice(patternIndex + 1).every((word) => !word.startsWith("-")))
      return { label: "搜索内容", target: [pattern, ...words.slice(patternIndex + 1)].join(" · ") };
  }
  return { label: "运行命令", target: command.replace(/\s+/gu, " ").trim() };
}

/**
 * @param call 实际工具调用；孤立结果可以不提供调用。
 * @param result 与调用配对的结果；应用动作只采用宿主记录的回执，不扫描脚本猜测执行事实。
 * @param targets 当前会话观察到的页面名称，按浏览器后端与页面标识定位。
 * @returns 具体动作、对象与可展开的完整执行源码；未知工具保留原名，不抛出异常。
 */
export function toolAction(call?: ToolCall, result?: ToolResult, targets: ReadonlyMap<string, string> = new Map()): ToolAction {
  const name = call?.name ?? result?.name ?? "工具";
  const args = object(call?.arguments) ? call.arguments : null;
  const text = (key: string): string => typeof args?.[key] === "string" ? args[key] : "";
  const action: ToolAction = { label: name, target: "", source: "", sourceLabel: "" };
  if (name === "terminal") {
    const command = text("cmd");
    return command ? { ...commandAction(command), source: command, sourceLabel: "命令" }
      : { ...action, label: terminalActions[text("action")] ?? "运行命令", target: text("session_id") };
  }
  if (name === "browser") return { ...action, label: browserActions[text("action")] ?? "浏览网页", target: text("url") || targets.get(`managed:${text("page")}`) || text("page") };
  if (name === "ui_repl") {
    action.label = text("type") === "reset" ? "重置脚本上下文" : "运行脚本";
    action.source = text("code");
    action.sourceLabel = "脚本";
    action.target = action.source.split("\n").find((line) => line.trim())?.trim() ?? "";
    const output = object(result?.output) ? result.output : null;
    if (Array.isArray(output?.["operations"])) {
      const operation: unknown = output["operations"].at(-1);
      const request = object(operation) && object(operation["request"]) ? operation["request"] : null;
      const value = request && object(request["action"]) ? request["action"] : null;
      if (request?.["domain"] === "browser" && typeof value?.["action"] === "string") {
        action.label = browserActions[value["action"]] ?? value["action"];
        const page = typeof value["page"] === "string" ? value["page"] : "";
        action.target = targets.get(`${String(request["backend"])}:${page}`) || page || action.target;
      } else if (request?.["domain"] === "computer" && typeof value?.["action"] === "string") {
        action.label = computerActions[value["action"]] ?? value["action"];
        const app = typeof value["app"] === "string" ? value["app"] : "";
        const window = typeof value["window"] === "string" ? value["window"] : "";
        action.target = targets.get(`computer:${app}:${window}`) || window || app || action.target;
      }
    }
  }
  return action;
}

/**
 * @param value 宿主 IPC 传入的可序列化 JSON；字符串按原文返回。
 * @returns 保留缩进与换行的全文，不截断。
 * @throws 非 JSON 值包含循环引用或 BigInt 时抛出 TypeError。
 */
export function toolValueText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

/**
 * @param messages 原生历史保证调用标识在整个历史中唯一的消息列表。
 * @returns 可合并的结果；名称不匹配或缺少调用的结果不消费，保留独立展示，不抛出异常。
 */
export function pairToolResults(messages: readonly AgentMessage[]): Map<string, ToolResult> {
  const calls = new Map<string, string>();
  for (const message of messages)
    for (const part of message.content)
      if (part.type === "tool_call") calls.set(part.value.id, part.value.name);
  const results = new Map<string, ToolResult>();
  for (const message of messages)
    for (const part of message.content)
      if (part.type === "tool_result" && calls.get(part.value.call_id) === part.value.name)
        results.set(part.value.call_id, part.value);
  return results;
}

/**
 * @param result 宿主返回的工具 JSON 与明确的错误标志。
 * @returns 正文、真实状态及截断提示；后台进程和副作用未知均不会标为已完成。
 * @throws 原始结果不是可序列化 JSON 时抛出 TypeError。
 */
export function toolOutput(result: ToolResult): ToolOutput {
  const value = object(result.output) ? result.output : null;
  const known = ["terminal", "browser", "ui_repl"].includes(result.name);
  const error = typeof value?.["error"] === "string" && (known || result.is_error)
    ? value["error"]
    : result.is_error && typeof result.output === "string" ? result.output : null;
  const view: ToolOutput = {
    text: toolValueText(result.output), label: "结果", error, note: null,
    state: result.is_error || error ? "未完成" : "已完成",
    tone: result.is_error || error ? "error" : "normal", extracted: false,
  };
  if (result.name === "terminal" && value) terminalOutput(value, view);
  else if (result.name === "browser" && value) browserOutput(value, view);
  else if (result.name === "ui_repl" && value) uiOutput(value, view);
  if (error && !view.extracted) {
    view.text = "";
    view.extracted = true;
  }
  return view;
}

function terminalOutput(value: Record<string, unknown>, view: ToolOutput): void {
  if (typeof value["output"] === "string") {
    view.text = value["output"];
    view.label = "输出";
    view.extracted = true;
  }
  if (view.tone !== "error") {
    if (value["status"] === "running") view.state = "后台运行";
    else if (value["status"] === "stopped") view.state = "已停止";
    else if (value["status"] === "timed_out" || value["status"] === "failed") {
      view.state = value["status"] === "timed_out" ? "已超时" : "未完成";
      view.tone = "error";
    } else if (typeof value["exit_code"] === "number" && value["exit_code"] !== 0) {
      view.state = `退出码 ${value["exit_code"]}`;
      view.tone = "error";
    } else if (typeof value["signal"] === "string") {
      view.state = `信号 ${value["signal"]}`;
      view.tone = "error";
    }
  }
  if (value["truncated"] === true)
    view.note = typeof value["omitted_chars"] === "number" && value["omitted_chars"] > 0
      ? `输出已截断，省略 ${value["omitted_chars"]} 字符` : "输出已截断";
  else if (value["has_more"] === true) view.note = "还有后续输出";
}

function browserOutput(value: Record<string, unknown>, view: ToolOutput): void {
  const page = value["text_page"], observation = value["observation"];
  if (object(page) && typeof page["text"] === "string") {
    view.text = page["text"];
    view.extracted = true;
    if (typeof page["next_offset"] === "number") view.note = "还有后续内容";
  } else if (object(observation) && typeof observation["text"] === "string") {
    view.text = observation["text"];
    view.extracted = true;
    if (observation["truncated"] === true) view.note = "页面内容已截断";
    if (Array.isArray(observation["warnings"])) {
      const warnings = observation["warnings"].filter((warning: unknown): warning is string => typeof warning === "string");
      if (warnings.length) view.note = [view.note, ...warnings].filter(Boolean).join("\n");
    }
  }
  if (view.extracted) view.label = "页面内容";
  if (value["outcome"] === "unknown") {
    view.state = "结果待核实";
    view.tone = "warning";
  } else if (value["outcome"] === "not_executed") view.state = "未执行";
}

function uiOutput(value: Record<string, unknown>, view: ToolOutput): void {
  // 页面优先解释错误原因；JavaScript 堆栈仍完整保留在可展开、可复制的原始结果中。
  if (view.error) view.error = view.error.replace(/\n[ \t]+at [\s\S]*$/u, "").replace(/^Error:[ \t]+(?=\S)/u, "");
  if (Array.isArray(value["prints"])) {
    view.text = value["prints"].map(toolValueText).join("\n");
    view.label = "返回内容";
    view.extracted = true;
  }
  if (Array.isArray(value["operations"]) &&
    value["operations"].some((operation: unknown) => object(operation) && operation["outcome"] === "unknown")) {
    view.state = "结果待核实";
    view.tone = "warning";
  } else if (Array.isArray(value["operations"]) &&
    value["operations"].some((operation: unknown) => object(operation) && operation["outcome"] === "not_executed")) {
    view.state = value["operations"].every((operation: unknown) => object(operation) && operation["outcome"] === "not_executed") ? "未执行" : "部分操作未执行";
    if (view.tone !== "error") view.tone = "warning";
  }
}
