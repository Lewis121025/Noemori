import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { PageExtensions, type BrowserExtensionAction } from "./extensions.js";
import { extensionWait, type ExtensionExecution } from "./webmcp.js";
import { record } from "./contract.js";

// Playwright 生成的 object 类型误将 WebMCP.input 限定为 string map；官方协议允许 JSON 对象。
declare module "playwright-core" {
  interface CDPSession {
    send(method: "WebMCP.invokeTool", params: { frameId: string; toolName: string; input: Record<string, unknown> }): Promise<{ invocationId: string }>;
  }
}

/** Playwright 只为本会话真实页面建立 CDP session，调试连接与目标身份不暴露给模型。 */
export class ManagedPageExtensions {
  private session: CDPSession | undefined;
  private extensions: PageExtensions | undefined;
  private connecting: Promise<void> | undefined;

  /** 保存实际 Page 对象；未使用扩展时不额外附着 CDP 或读取开发日志。 */
  constructor(private readonly context: BrowserContext, private readonly page: Page) {}

  /** 执行真实页面能力并返回有界结果；连接或协议失败原样交给上层结算。 */
  async execute(action: BrowserExtensionAction, execution: ExtensionExecution): Promise<Record<string, unknown>> {
    this.connecting ??= this.connect();
    await extensionWait(this.connecting, execution);
    if (!this.extensions) throw new Error("页面 CDP 能力没有连接");
    return this.extensions.execute(action, execution);
  }

  /** 人工接管与关联原生操作撤销权限，不允许下一轮代码自我恢复。 */
  invalidate(): void { this.extensions?.invalidate(); }

  private async connect(): Promise<void> {
    try {
      const session = await this.context.newCDPSession(this.page);
      this.session = session;
      const extensions = new PageExtensions({ send: (method, params) => sendPageCommand(session, method, params) });
      this.extensions = extensions;
      session.on("event", ({ method, params }) => extensions.event(method, record(params ?? {})));
      await session.send("Page.enable");
    } catch (error) {
      this.extensions?.invalidate();
      if (this.session && !this.page.isClosed()) {
        try { await this.session.detach(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "页面能力附着失败且调试连接未确认释放"); }
      }
      this.session = undefined;
      this.extensions = undefined;
      this.connecting = undefined;
      throw error;
    }
  }

  /** 页面关闭会由浏览器自动回收 session；活页面则显式 detach，失败由调用方报告。 */
  async close(): Promise<void> {
    this.extensions?.invalidate();
    if (this.connecting) await this.connecting;
    if (this.session && !this.page.isClosed()) await this.session.detach();
    this.session = undefined;
    this.extensions = undefined;
  }
}

function sendPageCommand(session: CDPSession, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const integer = (key: string): number => { const value = params[key]; if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`CDP ${key} 无效`); return value; };
  const text = (key: string): string => { const value = params[key]; if (typeof value !== "string") throw new Error(`CDP ${key} 无效`); return value; };
  const depth = params.depth === undefined ? {} : { depth: integer("depth") };
  switch (method) {
    case "Page.getFrameTree": return session.send(method);
    case "Page.getLayoutMetrics": return session.send(method);
    case "Runtime.enable": return session.send(method);
    case "Page.createIsolatedWorld": return session.send(method, { frameId: text("frameId"), worldName: text("worldName") });
    case "Runtime.evaluate": return session.send(method, { contextId: integer("contextId"), expression: text("expression"), returnByValue: true });
    case "Log.enable": return session.send(method);
    case "Performance.enable": return session.send(method);
    case "Performance.getMetrics": return session.send(method);
    case "DOM.getDocument": return session.send(method, { ...depth, pierce: false });
    case "DOM.describeNode": return session.send(method, { nodeId: integer("nodeId"), ...depth });
    case "DOM.getOuterHTML": return session.send(method, { nodeId: integer("nodeId") });
    case "DOM.getAttributes": return session.send(method, { nodeId: integer("nodeId") });
    case "DOM.getBoxModel": return session.send(method, { nodeId: integer("nodeId") });
    case "Accessibility.getFullAXTree": return session.send(method, depth);
    case "WebMCP.enable": return session.send(method);
    case "WebMCP.invokeTool": return session.send(method, { frameId: text("frameId"), toolName: text("toolName"), input: record(params.input) });
    case "WebMCP.cancelInvocation": return session.send(method, { invocationId: text("invocationId") });
    default: throw new Error("页面扩展协议方法未接入");
  }
}
