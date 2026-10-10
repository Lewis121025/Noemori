import { record } from "./contract.js";
import { boundedValue, type BoundedValue } from "./diagnostics.js";

/** 固定页面 session 的协议边界；调用方持有真实连接，模型不能提供 session。 */
export type ExtensionProtocol = { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
/** 当前扩展调用的预算；dispatch 必须在真正可能产生业务副作用之前登记。 */
export type ExtensionExecution = { signal: AbortSignal; check(): void; budget(): number; dispatch(): void };
/** 浏览器登记的工具元数据只用于解释与 Schema 校验，annotations 不授予任何权限。 */
export type WebMcpTool = { id: string; name: string; description: string; input_schema: Record<string, unknown>; annotations?: Record<string, unknown>; frame: string };
type RegisteredTool = { view: WebMcpTool };
type PreparedCall = { directory: string; tool: WebMcpTool; input: Record<string, unknown> };
type Completion = { status: string; output?: unknown; errorText?: string };

/**
 * 等待同一工具预算；取消不会将已经发送的命令包装成未执行。
 * @param work 已发出的协议命令或事件等待。
 * @param execution 当前动作的取消与截止时间。
 * @returns 未中断的原始结果。
 * @throws 取消、超时或原始协议错误。
 */
export async function extensionWait<T>(work: Promise<T>, execution: ExtensionExecution): Promise<T> {
  execution.check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("扩展操作已取消，已派发的业务动作不能重放"));
    execution.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("扩展操作超过当前预算，已派发的业务动作不能重放")), Math.max(1, execution.budget()));
    if (execution.signal.aborted) abort();
  });
  try {
    const value = await Promise.race([work, interrupted]);
    execution.check();
    return value;
  } finally {
    clearTimeout(timer);
    execution.signal.removeEventListener("abort", abort);
  }
}

/** Chromium 的真实实验性 WebMCP domain；不注入 polyfill，不信任页面自造的 API。 */
export class WebMcpDirectory {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly pending = new Map<string, (completion: Completion) => void>();
  private readonly early = new Map<string, Completion>();
  private invoking = false;
  private revision = crypto.randomUUID();
  private errors: string[] = [];
  supported = false;
  private frame = "";
  private readonly prepared = new Map<string, PreparedCall>();

  /** 只绑定当前页面 session；目录变化回调负责使审批中的旧目录身份失效。 */
  constructor(private readonly protocol: ExtensionProtocol) {}

  /** 固定当前主 frame；导航会清空工具身份，旧工具不能落到同名新工具。 */
  reset(frame: string): void {
    this.frame = frame;
    this.tools.clear();
    this.prepared.clear();
    this.errors = [];
    this.revision = crypto.randomUUID();
    for (const complete of this.pending.values()) complete({ status: "Canceled", errorText: "页面文档或控制权已变化，工具结果未知" });
    this.pending.clear();
    this.early.clear();
  }

  /** 探测真实 domain；只有 Chromium 明确报告未知方法才作为不支持，其他错误保留。 */
  async enable(execution: ExtensionExecution): Promise<void> {
    try {
      await extensionWait(this.protocol.send("WebMCP.enable"), execution);
      this.supported = true;
    } catch (error) {
      if (!(error instanceof Error) || !/(wasn't found|not found|unknown method|method.*not.*supported|-32601)/i.test(error.message)) throw error;
      this.supported = false;
    }
  }

  /** 获取与本目录代次绑定的工具；超限或无效 Schema 工具不会被广告为可调用。 */
  list(): { directory: string; tools: WebMcpTool[]; warnings: string[]; truncated: boolean } {
    if (!this.supported) throw new Error("当前 Chromium 未提供真实 WebMCP domain");
    const tools: WebMcpTool[] = [];
    let bytes = 0;
    for (const tool of this.tools.values()) {
      const size = new TextEncoder().encode(JSON.stringify(tool.view)).length;
      if (bytes + size > 64000) break;
      tools.push(structuredClone(tool.view));
      bytes += size;
    }
    return { directory: this.revision, tools, warnings: [...this.errors], truncated: tools.length < this.tools.size };
  }

  /** 当前不可变目录身份用于审批返回后的重验；不包含页面内容授权。 */
  get identity(): string { return this.revision; }

  /** 接收浏览器的标准 WebMCP 事件，只登记当前主 frame 的工具。 */
  event(method: string, values: Record<string, unknown>): void {
    if (method === "WebMCP.toolResponded") {
      if (typeof values.invocationId !== "string" || typeof values.status !== "string") return;
      const completion: Completion = { status: values.status, output: values.output, ...(typeof values.errorText === "string" ? { errorText: values.errorText.slice(0, 2000) } : {}) };
      const callback = this.pending.get(values.invocationId);
      if (callback) callback(completion);
      else if (this.invoking && this.early.size < 16) this.early.set(values.invocationId, completion);
      return;
    }
    if (method !== "WebMCP.toolsAdded" && method !== "WebMCP.toolsRemoved") return;
    if (!Array.isArray(values.tools)) return;
    this.revision = crypto.randomUUID();
    this.prepared.clear();
    for (const raw of values.tools.slice(0, 100)) {
      try {
        const item = record(raw);
        if (item.frameId !== this.frame) continue;
        if (typeof item.name !== "string" || !item.name || item.name.length > 256) throw new Error("WebMCP 工具名无效");
        if (method === "WebMCP.toolsRemoved") { this.tools.delete(item.name); continue; }
        if (this.tools.size >= 100 && !this.tools.has(item.name)) throw new Error("WebMCP 工具目录超过 100 项");
        this.tools.delete(item.name);
        if (typeof item.description !== "string" || item.description.length > 4000) throw new Error("WebMCP 工具描述超限");
        const schema = item.inputSchema === undefined ? { type: "object", additionalProperties: false } : record(item.inputSchema);
        checkSchemaBudget(schema);
        const annotations = item.annotations === undefined ? undefined : record(item.annotations);
        const view: WebMcpTool = { id: crypto.randomUUID(), name: item.name, description: item.description, input_schema: structuredClone(schema), frame: this.frame, ...(annotations ? { annotations: Object.fromEntries(Object.entries(annotations).filter(([, value]) => typeof value === "boolean").slice(0, 10)) } : {}) };
        this.tools.set(item.name, { view });
      } catch (error) {
        if (this.errors.length < 20) this.errors.push((error instanceof Error ? error.message : String(error)).slice(0, 500));
      }
    }
    if (values.tools.length > 100 && this.errors.length < 20) this.errors.push("WebMCP 事件超过目录预算，省略剩余工具");
  }

  /**
   * 准备不可变调用供 Rust jsonschema 验证，MV3 不执行动态代码生成的 Schema 编译器。
   * @param directory 最近发现的目录代次。
   * @param id 同一目录返回的宿主不透明工具身份。
   * @param input 符合浏览器登记 Schema 的 JSON 对象。
   * @returns 一次性身份及真实 Schema 和独立输入；不调用网页工具。
   * @throws 身份无效或输入超限时抛出错误，不派发。
   */
  prepare(directory: string, id: string, input: Record<string, unknown>): { prepared: string; schema: Record<string, unknown>; input: Record<string, unknown> } {
    if (!this.supported || directory !== this.revision) throw new Error("WebMCP 目录已经失效，请重新发现工具");
    const tool = [...this.tools.values()].find((entry) => entry.view.id === id);
    if (!tool) throw new Error("WebMCP 工具不属于当前页面目录");
    const argumentsValue = structuredClone(input);
    if (new TextEncoder().encode(JSON.stringify(argumentsValue)).length > 65536) throw new Error("WebMCP 输入超过 64 KiB");
    this.prepared.clear();
    const prepared = crypto.randomUUID();
    this.prepared.set(prepared, { directory, tool: structuredClone(tool.view), input: argumentsValue });
    return { prepared, schema: structuredClone(tool.view.input_schema), input: structuredClone(argumentsValue) };
  }

  /** 宿主完成 Schema 校验后消费一次性准备身份；目录变化或重复调用不会派发。 */
  async invoke(prepared: string, execution: ExtensionExecution): Promise<BoundedValue> {
    const call = this.prepared.get(prepared);
    this.prepared.delete(prepared);
    if (!call || call.directory !== this.revision) throw new Error("WebMCP 准备身份已失效或已消费，请重新发现，不要重放");
    execution.check();
    execution.dispatch();
    this.invoking = true;
    let invocation: string | undefined;
    let completed = false;
    const command = this.protocol.send("WebMCP.invokeTool", { frameId: call.tool.frame, toolName: call.tool.name, input: call.input });
    try {
      const response = record(await extensionWait(command, execution));
      if (typeof response.invocationId !== "string") throw new Error("WebMCP 未返回调用身份，副作用未知");
      const id = response.invocationId;
      invocation = id;
      const early = this.early.get(id);
      const result = await extensionWait(early ? Promise.resolve(early) : new Promise<Completion>((resolve) => this.pending.set(id, resolve)), execution);
      if (result.status !== "Completed") throw new Error(result.errorText ?? `WebMCP 工具结算为 ${result.status}，请检查网页状态`);
      completed = true;
      return boundedValue(result.output);
    } finally {
      this.invoking = false;
      this.early.clear();
      if (invocation) this.pending.delete(invocation);
      if (!completed) {
        this.revision = crypto.randomUUID();
        // 协议命令可能在取消后才返回 invocationId；迟到调用仍须取消，不能重放。
        void command.then(async (raw) => {
          const value = record(raw);
          if (typeof value.invocationId === "string") await this.protocol.send("WebMCP.cancelInvocation", { invocationId: value.invocationId });
        }).catch((error: unknown) => {
          if (this.errors.length < 20) this.errors.push(`WebMCP 取消未获确认：${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
        });
      }
    }
  }
}

function checkSchemaBudget(schema: Record<string, unknown>): void {
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 32768) throw new Error("WebMCP 输入 Schema 超过 32 KiB");
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 1000 || depth > 24) throw new Error("WebMCP 输入 Schema 复杂度超限");
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(schema, 0);
}
