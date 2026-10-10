import { record } from "./contract.js";

/** 诊断结果始终保留截断事实，原始 CDP 远程句柄不能进入模型输出。 */
export type BoundedValue = { value?: unknown; text?: string; truncated: boolean; bytes: number };

/**
 * 将协议结果限制在 32 KiB；超限仅返回 JSON 前缀，不能冒充完整结构。
 * @param value CDP 返回的可序列化值。
 * @returns 完整 JSON 值或明确标记的有界文本。
 * @throws JSON 无法编码时抛出错误。
 */
export function boundedValue(value: unknown): BoundedValue {
  const json = JSON.stringify(value ?? null);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes <= 32768) return { value: value ?? null, truncated: false, bytes };
  return { text: json.slice(0, 8000), truncated: true, bytes };
}

/** 受控 CDP 只提供固定页面的读取；不能获取浏览器级目标、网络、文件或执行代码。 */
export const CDP_METHODS = Object.freeze([
  "Page.getLayoutMetrics",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "DOM.getBoxModel",
  "Accessibility.getFullAXTree",
  "Performance.getMetrics",
]);

/**
 * 精确校验只读方法及参数，额外目标字段不能透传给浏览器。
 * @param method 模型请求的方法名称。
 * @param params 独立的 JSON 参数对象。
 * @returns 验证后的参数副本；页面 session 由调用方固定。
 * @throws 方法或参数超出受控诊断范围时抛出错误，不发送 CDP。
 */
export function diagnosticParams(method: string, params: unknown): Record<string, unknown> {
  const input = record(params);
  const output: Record<string, unknown> = {};
  const integer = (key: string, minimum: number, maximum: number, required = false): void => {
    const value = input[key];
    if (value === undefined && !required) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`CDP 参数 ${key} 无效`);
    output[key] = value;
  };
  switch (method) {
    case "Page.getLayoutMetrics":
    case "Performance.getMetrics":
      break;
    case "DOM.getDocument":
      integer("depth", 0, 8);
      if (input.pierce !== undefined && input.pierce !== false)
        throw new Error("受控 CDP 不开放跨目标穿透");
      if (input.pierce === false) output.pierce = false;
      break;
    case "DOM.describeNode":
      integer("nodeId", 1, Number.MAX_SAFE_INTEGER, true);
      integer("depth", 0, 8);
      break;
    case "DOM.getOuterHTML":
    case "DOM.getAttributes":
    case "DOM.getBoxModel":
      integer("nodeId", 1, Number.MAX_SAFE_INTEGER, true);
      break;
    case "Accessibility.getFullAXTree":
      integer("depth", 0, 8);
      break;
    default:
      throw new Error("CDP 方法不在页面只读诊断范围内；请先读取 capability_get('cdp')");
  }
  for (const key of Object.keys(input))
    if (!Object.hasOwn(output, key)) throw new Error(`CDP 不允许参数 ${key}`);
  return output;
}

/** 开发日志只保存文本和来源事实，不解析网页声明的权限或触发远程对象 getter。 */
export type DeveloperLog = {
  sequence: number;
  kind: "console" | "exception" | "log";
  level: string;
  text: string;
  timestamp?: number;
  url?: string;
  truncated?: boolean;
};

/** 单个文档的有界日志环；内存和分页输出都有独立预算。 */
export class DeveloperLogs {
  private entries: DeveloperLog[] = [];
  private sequence = 0;
  private bytes = 0;

  /** 导航或控制权变化时清除旧数据，序号保持递增以明确旧 cursor 已丢失。 */
  clear(): void {
    this.entries = [];
    this.bytes = 0;
  }

  /** 接收固定页面 session 的协议事件；无关事件直接忽略，坏日志不得打断网页交互。 */
  event(method: string, values: Record<string, unknown>): void {
    let entry: Omit<DeveloperLog, "sequence"> | undefined;
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(values.args) ? values.args.slice(0, 32) : [];
      const text = args.map((arg: unknown) => {
        if (typeof arg !== "object" || arg === null || Array.isArray(arg)) return "[无效参数]";
        const item = record(arg);
        if (["string", "number", "boolean"].includes(typeof item.value)) return String(item.value);
        if (item.value === null) return "null";
        return typeof item.description === "string" ? item.description : `[${String(item.type ?? "object")}]`;
      }).join(" ");
      entry = { kind: "console", level: typeof values.type === "string" ? values.type : "log", text };
    } else if (method === "Runtime.exceptionThrown") {
      if (typeof values.exceptionDetails !== "object" || values.exceptionDetails === null) return;
      const details = record(values.exceptionDetails);
      const exception = typeof details.exception === "object" && details.exception !== null ? record(details.exception) : {};
      entry = { kind: "exception", level: "error", text: String(exception.description ?? details.text ?? "页面异常"), ...(typeof details.url === "string" ? { url: details.url } : {}) };
    } else if (method === "Log.entryAdded") {
      if (typeof values.entry !== "object" || values.entry === null) return;
      const data = record(values.entry);
      entry = { kind: "log", level: String(data.level ?? "info"), text: String(data.text ?? ""), ...(typeof data.url === "string" ? { url: data.url } : {}) };
      if (typeof data.timestamp === "number" && Number.isFinite(data.timestamp)) entry.timestamp = data.timestamp;
    }
    if (!entry) return;
    if (typeof values.timestamp === "number" && Number.isFinite(values.timestamp)) entry.timestamp = values.timestamp;
    if (entry.text.length > 2000 || entry.level.length > 32 || (entry.url?.length ?? 0) > 2000 || method === "Runtime.consoleAPICalled" && Array.isArray(values.args) && values.args.length > 32) entry.truncated = true;
    entry.text = entry.text.slice(0, 2000);
    entry.level = entry.level.slice(0, 32);
    if (entry.url) entry.url = entry.url.slice(0, 2000);
    const saved = { ...entry, sequence: ++this.sequence };
    // 单条归一化到分页预算以内，控制字符与中文也按实际 UTF-8 JSON 字节计算。
    while (jsonBytes(saved) > 8000) {
      saved.text = saved.text.slice(0, Math.floor(saved.text.length / 2));
      if (saved.url) saved.url = saved.url.slice(0, Math.floor(saved.url.length / 2));
      saved.truncated = true;
    }
    this.entries.push(saved);
    this.bytes += jsonBytes(saved);
    while (this.entries.length > 500 || this.bytes > 64000) {
      const dropped = this.entries.shift();
      if (dropped) this.bytes -= jsonBytes(dropped);
    }
  }

  /** 返回不超过 16 KiB 的增量日志，并声明旧 cursor 丢失和下一读取位置。 */
  read(after: number, limit: number): { entries: DeveloperLog[]; next: number; dropped_before: number; more: boolean } {
    const entries: DeveloperLog[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      if (entry.sequence <= after) continue;
      const size = jsonBytes(entry) + 1;
      if (entries.length >= limit || bytes + size > 15800) break;
      entries.push({ ...entry });
      bytes += size;
    }
    const next = entries.at(-1)?.sequence ?? after;
    return { entries, next, dropped_before: (this.entries[0]?.sequence ?? this.sequence + 1) - 1, more: this.entries.some((entry) => entry.sequence > next) };
  }
}

function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
