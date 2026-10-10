import { parseHandoff, type HandoffRequest, type HandoffState } from "./handoff.js";
import { parseSemanticAction, type SemanticAction } from "./semantic.js";
import { isExtensionAction, parseExtensionAction, type BrowserExtensionAction } from "./extensions.js";

import type { ObservationPolicy, ObservationRequest, ObservationUpdate } from "./observation-update.js";

/** 批量步骤只操作已经观察到的表单控件；不包含导航、脚本或权限操作。 */
export type BrowserStep =
  | { action: "click"; ref: string }
  | { action: "fill"; ref: string; text: string }
  | { action: "select"; ref: string; values: string[]; by?: "label" | "value" }
  | { action: "check"; ref: string; checked: boolean };

/** 浏览器动作只引用宿主分配的页面与观察；总 JSON 限 1 MiB，超限作为可纠正的输入错误拒绝。 */
export type BrowserAction = (
  | BrowserExtensionAction
  | SemanticAction
  | { action: "human_navigate"; command: BrowserNavigation }
  | { action: "preview"; page: string }
  | { action: "human_input"; page: string; token: string; input: BrowserHumanInput }
  | { action: "allow_origin"; origin: string }
  | { action: "tabs" }
  | { action: "open"; url: string }
  | { action: "navigate"; page: string; url: string }
  | { action: "back"; page: string }
  | { action: "forward"; page: string }
  | { action: "reload"; page: string }
  | { action: "close"; page: string }
  | ({ action: "observe"; page: string } & ObservationRequest)
  | { action: "read"; page: string; offset: number }
  | { action: "find"; page: string; text: string; exact?: boolean }
  | { action: "choose_files"; page: string; paths: string[] }
  | { action: "screenshot"; page: string }
  | (BrowserStep & { page: string; observation: string })
  | { action: "batch"; page: string; observation: string; steps: BrowserStep[] }
  | { action: "hover"; page: string; observation: string; ref: string }
  | { action: "press"; page: string; observation: string; key: string; ref?: string }
  | { action: "type"; page: string; observation: string; text: string; ref?: string }
  | { action: "scroll"; page: string; observation: string; x: number; y: number }
  | {
      action: "pointer";
      page: string;
      observation: string;
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      clicks: number;
    }
  | {
      action: "drag";
      page: string;
      observation: string;
      from_x: number;
      from_y: number;
      to_x: number;
      to_y: number;
    }
  | { action: "wait"; page: string; text: string; state: "visible" | "hidden"; exact?: boolean }
  | { action: "dialog"; page: string; accept: boolean; text?: string }
  | { action: "upload"; page: string; observation: string; ref: string; paths: string[] }
  | { action: "downloads" }
  | { action: "arm_download"; page: string }
  | { action: "await_download"; page: string }
  | { action: "invalidate" }
  | { action: "save_download"; id: string; path: string }
  | { action: "handoff"; completion?: HandoffRequest }
  | { action: "takeover" }
  | { action: "resume" }
) & { observation_mode?: ObservationPolicy };

/** 用户地址栏与标签页的导航命令，不包含脚本或权限操作。 */
export type BrowserNavigation = Extract<BrowserAction, { action: "open" | "navigate" | "back" | "forward" | "reload" | "close" }>;

/** 可信预览窗口的人工输入；只在用户接管期间接受，不共享模型观察。 */
export type BrowserHumanInput =
  | { type: "dialog"; accept: boolean; text?: string }
  | { type: "files"; paths: string[] }
  | {
      type: "pointer";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      /** 连续点击编号；每条人工输入只发送一次按下与释放。 */
      clicks?: number;
    }
  | { type: "drag"; from_x: number; from_y: number; to_x: number; to_y: number }
  | { type: "scroll"; x: number; y: number; at_x?: number; at_y?: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

/** 校验人工输入的尺寸和文本预算；无效输入在派发前抛出错误。 */
export function parseHumanInput(value: unknown): BrowserHumanInput {
  const input = record(value);
  const type = text(input, "type", 16);
  if (type === "drag") return { type, from_x: number(input, "from_x", 0, 4096), from_y: number(input, "from_y", 0, 4096), to_x: number(input, "to_x", 0, 4096), to_y: number(input, "to_y", 0, 4096) };
  if (type === "pointer" || type === "scroll") {
    const point = { x: number(input, "x", type === "pointer" ? 0 : -10000, type === "pointer" ? 4096 : 10000), y: number(input, "y", type === "pointer" ? 0 : -10000, type === "pointer" ? 4096 : 10000) };
    if (type === "scroll") return { type, ...point, ...(input.at_x === undefined && input.at_y === undefined ? {} : { at_x: number(input, "at_x", 0, 4096), at_y: number(input, "at_y", 0, 4096) }) };
    const button = input.button;
    if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") throw new Error("人工鼠标按钮无效");
    const clicks = input.clicks;
    if (clicks !== undefined && (typeof clicks !== "number" || !Number.isSafeInteger(clicks) || clicks < 1 || clicks > 3)) throw new Error("人工点击次数无效");
    return { type, ...point, ...(button === undefined ? {} : { button }), ...(clicks === undefined ? {} : { clicks }) };
  }
  if (type === "dialog") return { type, accept: boolean(input, "accept"), ...(input.text === undefined ? {} : { text: text(input, "text", 16384) }) };
  if (type === "files") return { type, paths: strings(input, "paths") };
  if (type === "key") return { type, key: text(input, "key", 100) };
  if (type === "text") return { type, text: text(input, "text", 16384) };
  throw new Error("人工输入类型无效");
}

/** 启动配置由 Rust 宿主提供；工作区、文件与资源边界不能由工具动作改变。 */
export type BrowserSettings = {
  workspace: string;
  download_directory: string;
  max_pages: number;
  max_chars: number;
  max_elements: number;
  max_download_bytes: number;
};

/** 页面元数据不暴露 Cookie、调试连接或浏览器对象。 */
export type TabState = {
  id: string;
  native_target?: string;
  url: string;
  title: string;
  crashed: boolean;
  file_chooser: boolean;
  dialog: { type: string; message: string } | null;
};

/** 控件引用只在所属观察内有效；描述与实际 ElementHandle 共同建立。 */
export type ElementState = { ref: string; frame: string; description: string };

/** 观察包含当前页面证据；正文与控件裁剪都必须显式标记。 */
export type Observation = {
  id: string;
  page: string;
  url: string;
  title: string;
  text: string;
  elements: ElementState[];
  truncated: boolean;
  warnings: string[];
  viewport: { width: number; height: number };
};

/** 工具结果区分未执行、执行后观察与副作用未知；未知结果不得自动重放。 */
export type BrowserResult = {
  handoff?: HandoffState | null;
  page?: string;
  extensions?: Record<string, unknown>;
  input_token?: string;
  steps?: {
    index: number;
    action: string;
    outcome: "executed" | "not_executed" | "unknown";
    error?: string;
  }[];
  outcome: "observed" | "executed" | "not_executed" | "unknown";
  error?: string;
  tabs: TabState[];
  mode: "agent" | "human";
  observation?: Observation;
  observation_update?: ObservationUpdate;
  image?: { format: "jpeg"; data: string };
  downloads?: DownloadState[];
  saved_path?: string;
  text_page?: { text: string; offset: number; next_offset: number | null; total_chars: number };
  locator_result?: Record<string, unknown>;
};

/** 下载完成只表示已经落入私有暂存区，显式保存才写入工作区。 */
export type DownloadState = {
  page?: string;
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  bytes: number;
  error: string | null;
};

/**
 * 控制帧与动作共用对象边界，校验成功后保留字段为 unknown，不能绕过后续字段校验。
 * @param value 未信任的 JSON 值。
 * @returns 已确认不是 null 或数组的对象。
 * @throws 非对象输入时抛出协议错误。
 */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("浏览器协议需要对象");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(input: Record<string, unknown>, key: string, maximum = 8192): string {
  const value = input[key];
  if (typeof value !== "string" || Array.from(value).length > maximum || value.includes("\0"))
    throw new Error(`浏览器字段 ${key} 无效`);
  return value;
}
function number(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`浏览器字段 ${key} 超出范围`);
  return value;
}
function boolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") throw new Error(`浏览器字段 ${key} 需要布尔值`);
  return value;
}
function strings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length > 50) throw new Error(`浏览器字段 ${key} 需要有界数组`);
  return value.map((item: unknown) => text({ item }, "item"));
}

/**
 * 校验 IPC 动作并创建独立值；未知动作与超限输入在访问页面前拒绝。
 * @param value 宿主控制管道收到的动作，包含宿主专用控制动作。
 * @returns 字段经过校验的独立动作值；不访问页面或改变浏览器状态。
 * @throws 输入结构、字段类型、枚举值或资源上限无效时抛出协议错误。
 */
export function parseAction(value: unknown): BrowserAction {
  const input = record(value);
  const result = parseActionFields(input);
  if ((input.mode !== undefined || input.baseline !== undefined) && result.action !== "observe")
    throw new Error("mode 和 baseline 仅用于显式 observe");
  if (input.observation_mode === undefined) return result;
  const policy = input.observation_mode;
  if (policy !== "full" && policy !== "delta" && policy !== "none")
    throw new Error("动作后观察模式必须是 full、delta 或 none");
  if (!["open", "navigate", "back", "forward", "reload", "find", "wait", "choose_files", "click", "fill", "select", "check", "hover", "press", "type", "scroll", "pointer", "drag", "batch", "dialog", "upload", "locator", "webmcp_call", "webmcp_invoke"].includes(result.action))
    throw new Error("该动作不支持动作后观察模式");
  return { ...result, observation_mode: policy };
}

function parseActionFields(input: Record<string, unknown>): BrowserAction {
  // 与 Rust 输入契约一致；聚合超限属于普通动作错误，不能摧毁当前登录态和标签页。
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024)
    throw new Error("浏览器动作 JSON 超过 1 MiB，请拆分批量步骤或缩短输入");
  const action = text(input, "action", 32);
  switch (action) {
    case "human_navigate": {
      const command = parseAction(input.command);
      if (!["open", "navigate", "back", "forward", "reload", "close"].includes(command.action))
        throw new Error("用户导航动作无效");
      if (command.action === "open" || command.action === "navigate" || command.action === "back" || command.action === "forward" || command.action === "reload" || command.action === "close")
        return { action, command };
      throw new Error("用户导航动作无效");
    }
    case "handoff":
      return { action, ...(input.completion === undefined ? {} : { completion: parseHandoff(input.completion) }) };
    case "allow_origin":
      return { action, origin: text(input, "origin") };
    case "tabs":
    case "downloads":
    case "takeover":
    case "resume":
    case "invalidate":
      return { action };
    case "open":
      return { action, url: text(input, "url") };
    case "save_download":
      return { action, id: text(input, "id", 128), path: text(input, "path") };
  }
  const page = text(input, "page", 128);
  if (isExtensionAction(action)) return parseExtensionAction(input, page);
  switch (action) {
    case "human_input":
      return { action, page, token: text(input, "token", 128), input: parseHumanInput(input.input) };
    case "navigate":
      return { action, page, url: text(input, "url") };
    case "back":
    case "forward":
    case "reload":
    case "close":
    case "screenshot":
    case "preview":
    case "arm_download":
    case "await_download":
      return { action, page };
    case "observe": {
      const mode = input.mode;
      if (mode !== undefined && mode !== "full" && mode !== "delta")
        throw new Error("观察模式必须是 full 或 delta");
      const baseline = input.baseline === undefined ? undefined : text(input, "baseline", 128);
      if (baseline === "") throw new Error("观察基线不能为空");
      return { action, page, ...(mode === undefined ? {} : { mode }), ...(baseline === undefined ? {} : { baseline }) };
    }
    case "read": {
      const offset = input.offset === undefined ? 0 : number(input, "offset", 0, 10_000_000);
      if (!Number.isSafeInteger(offset)) throw new Error("正文偏移必须为整数");
      return { action, page, offset };
    }
    case "locator":
      return parseSemanticAction(input, page);
    case "find":
      return {
        action,
        page,
        text: text(input, "text", 4096),
        exact: input.exact === undefined ? true : boolean(input, "exact"),
      };
    case "choose_files":
      return { action, page, paths: strings(input, "paths") };
    case "wait": {
      const state = text(input, "state");
      if (state !== "visible" && state !== "hidden") throw new Error("等待状态无效");
      return {
        action,
        page,
        text: text(input, "text", 4096),
        state,
        exact: input.exact === undefined ? true : boolean(input, "exact"),
      };
    }
    case "dialog":
      return {
        action,
        page,
        accept: boolean(input, "accept"),
        ...(input.text === undefined ? {} : { text: text(input, "text") }),
      };
  }
  const observation = text(input, "observation", 128);
  switch (action) {
    case "batch": {
      if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 16)
        throw new Error("批量操作必须包含 1–16 个控件步骤");
      return { action, page, observation, steps: input.steps.map(parseStep) };
    }
    case "scroll":
      return {
        action,
        page,
        observation,
        x: number(input, "x", -10000, 10000),
        y: number(input, "y", -10000, 10000),
      };
    case "pointer": {
      const button = text(input, "button");
      if (button !== "left" && button !== "right" && button !== "middle")
        throw new Error("鼠标按键无效");
      const clicks = number(input, "clicks", 1, 2);
      if (!Number.isInteger(clicks)) throw new Error("点击次数必须为整数");
      return {
        action,
        page,
        observation,
        x: number(input, "x", 0, 4096),
        y: number(input, "y", 0, 4096),
        button,
        clicks,
      };
    }
    case "drag":
      return {
        action,
        page,
        observation,
        from_x: number(input, "from_x", 0, 4096),
        from_y: number(input, "from_y", 0, 4096),
        to_x: number(input, "to_x", 0, 4096),
        to_y: number(input, "to_y", 0, 4096),
      };
    case "press":
      return {
        action,
        page,
        observation,
        key: text(input, "key", 100),
        ...(input.ref === undefined ? {} : { ref: text(input, "ref", 128) }),
      };
    case "type":
      return {
        action,
        page,
        observation,
        text: text(input, "text", 16384),
        ...(input.ref === undefined ? {} : { ref: text(input, "ref", 128) }),
      };
  }
  if (action === "hover") return { action, page, observation, ref: text(input, "ref", 128) };
  if (action === "upload")
    return {
      action,
      page,
      observation,
      ref: text(input, "ref", 128),
      paths: strings(input, "paths"),
    };
  return { ...parseStep(input), page, observation };
}

function parseStep(value: unknown): BrowserStep {
  const input = record(value);
  const action = text(input, "action", 32);
  const ref = text(input, "ref", 128);
  switch (action) {
    case "click":
      return { action, ref };
    case "fill":
      return { action, ref, text: text(input, "text", 65536) };
    case "select":
      if (input.by !== undefined && input.by !== "label" && input.by !== "value")
        throw new Error("下拉框选择模式无效");
      return { action, ref, values: strings(input, "values"), by: input.by ?? "label" };
    case "check":
      return { action, ref, checked: boolean(input, "checked") };
    default:
      throw new Error(`未知控件动作：${action}`);
  }
}

/**
 * 只接受网络网页；局部 data/blob 内容由已打开网站内部使用，模型不能借此导航本地文件。
 * @param source 用户任务提供的绝对网络地址。
 * @returns 规范化的 HTTP(S) 地址；网络来源权限由出口另行核验。
 * @throws 地址无法解析、协议不支持或带有内嵌凭据时抛出错误。
 */
export function navigationUrl(source: string): string {
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("浏览器导航需要无内嵌凭据的 HTTP(S) URL");
  return url.href;
}
