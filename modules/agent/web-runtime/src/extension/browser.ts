import {
  parseAction,
  navigationUrl,
  record,
  type BrowserAction,
  type BrowserResult,
} from "../browser/contract.js";
import { ExtensionPage } from "./page.js";
import { Downloads } from "./downloads.js";
import { Operation, type CdpSession, type CdpTransport } from "./transport.js";
import type { NativeBridge } from "./bridge.js";

/** 一条明确共享的浏览器会话；关闭只释放调试租约，不关闭用户浏览器。 */
export class ExtensionBrowser {
  private readonly pages = new Map<string, ExtensionPage>();
  private readonly files: Downloads;
  private human = false;
  private taskWindow: number | undefined;
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | null = null;
  private tabErrors: { page: string; error: string }[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** 固定连接代次、会话及传输，任务标签页仍由共享回调登记在宿主。 */
  constructor(
    readonly session: string,
    private readonly connection: string,
    private readonly transport: CdpTransport,
    bridge: NativeBridge,
    private readonly shared: (session: string, tabs: BrowserResult["tabs"]) => void,
  ) {
    this.files = new Downloads(session, transport, bridge);
  }
  /** 新增用户明确共享或关联弹窗的标签页，不附着未授权页面。 */
  async share(tab: number): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error("浏览器会话已关闭");
    if (this.pages.size >= 32) throw new Error("共享标签页超过会话上限");
    const id = `${this.connection}:${tab}`;
    if (!this.pages.has(id))
      this.pages.set(id, new ExtensionPage(id, tab, this.transport, this.files));
    await this.publish();
  }
  /** 判断 tab 是否由当前会话持有，用于关联 popup 和协议事件。 */
  owns(tab: number): boolean {
    return [...this.pages.values()].some((page) => page.tab === tab);
  }
  /** 系统确认专用窗口关闭后撤销其身份，后续新页面不能复用失效窗口编号。 */
  windowClosed(window: number): void {
    if (this.taskWindow === window) this.taskWindow = undefined;
  }
  /** 用户关闭或取消调试后停止派发，不自动重新附着。 */
  lost(tab: number, closed: boolean): void {
    const entry = [...this.pages.values()].find((page) => page.tab === tab);
    if (!entry) return;
    entry.disconnected();
    if (closed) this.pages.delete(entry.id);
    else this.human = true;
    this.files.cancel();
  }
  /** 协议事件只能进入实际持有 tab 的页面，子会话由页面继续核验。 */
  async event(source: CdpSession, method: string, values: Record<string, unknown>): Promise<void> {
    if (source.tabId === undefined) return;
    const page = [...this.pages.values()].find((page) => page.tab === source.tabId);
    if (page) await page.event(source, method, values);
  }
  /** 原生关联操作使引用失效，但不会重新授予或撤销人工前台控制。 */
  invalidate(): void {
    for (const page of this.pages.values()) { page.invalidate(); page.invalidateCapabilities(); }
  }
  /** 取消此会话捕获；正在执行的输入由对应操作信号停止。 */
  cancel(): void {
    this.files.cancel();
  }
  /** 按接收顺序执行操作，人工交还控制是宿主专用动作。 */
  async execute(
    raw: unknown,
    signal: AbortSignal,
    timeout: number,
  ): Promise<Record<string, unknown>> {
    const operation = new Operation(
      AbortSignal.any([signal, this.lifetime.signal]),
      performance.now() + timeout,
    );
    const work = this.queue.then(() => this.perform(raw, operation));
    this.queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  private async tabs(): Promise<BrowserResult["tabs"]> {
    const pages = [...this.pages.values()];
    const results = await Promise.allSettled(pages.map((page) => page.state()));
    this.tabErrors = [];
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [result.value];
      const page = pages[index];
      if (!page) return [];
      this.tabErrors.push({
        page: page.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return [
        { id: page.id, url: "", title: "", crashed: true, dialog: null, file_chooser: false },
      ];
    });
  }
  private async base(outcome: BrowserResult["outcome"]): Promise<Record<string, unknown>> {
    return {
      outcome,
      mode: this.human ? "human" : "agent",
      tabs: await this.tabs(),
      downloads: this.files.states(),
      tab_errors: this.tabErrors,
    };
  }
  private async publish(): Promise<void> {
    this.shared(this.session, await this.tabs());
  }
  private async perform(raw: unknown, operation: Operation): Promise<Record<string, unknown>> {
    const value = record(raw);
    try {
      operation.check();
      if (value.action === "upload_bytes" || value.action === "choose_files_bytes")
        return await this.upload(value, operation);
      const action = parseAction(raw);
      if (action.action === "tabs") return this.base("observed");
      if (action.action === "downloads") return this.base("observed");
      if (action.action === "invalidate") {
        this.invalidate();
        return this.base("executed");
      }
      if (action.action === "takeover") throw new Error("宿主接管原语仅用于专用浏览器");
      if (action.action === "handoff" && action.completion) throw new Error("自动协助仅用于 managed 浏览器，外接浏览器请使用 b.handoff()");
      if (action.action === "handoff" || action.action === "resume") {
        if (action.action === "handoff") {
          this.human = true;
          this.files.cancel();
          for (const page of this.pages.values()) await page.detach();
        } else {
          for (const page of this.pages.values()) await page.attach();
          this.human = false;
        }
        return this.base("executed");
      }
      if (this.human) throw new Error("用户持有控制权，必须从可信界面交还");
      if (action.action === "human_navigate") throw new Error("用户工具栏导航仅用于窗口内浏览器");
      if (action.action === "allow_origin" || action.action === "save_download")
        throw new Error("扩展不拥有匿名网关或工作区文件权限");
      if (action.action === "open") {
        if (this.pages.size >= 32) throw new Error("会话标签页达到上限");
        operation.dispatch();
        const url = navigationUrl(action.url);
        let tab: chrome.tabs.Tab | undefined;
        if (this.taskWindow === undefined) {
          const window = await chrome.windows.create({ url, focused: false, type: "normal" });
          if (!window) throw new Error("浏览器没有创建专用窗口");
          this.taskWindow = window.id;
          tab = window.tabs?.[0];
        } else {
          tab = await chrome.tabs.create({ windowId: this.taskWindow, url, active: false });
        }
        if (!tab || this.taskWindow === undefined) throw new Error("浏览器没有返回专用窗口");
        if (tab.id === undefined) throw new Error("浏览器没有返回新标签页身份");
        if (this.lifetime.signal.aborted) {
          await chrome.tabs.remove(tab.id);
          throw new Error("会话已关闭，迟到的任务标签页已清理");
        }
        await this.share(tab.id);
        operation.check();
        const page = this.pages.get(`${this.connection}:${tab.id}`);
        if (!page) throw new Error("任务页面没有登记");
        return { ...(await this.base("executed")), ...(await page.afterObserved(action, operation)), page: page.id };
      }
      const page = this.pages.get(action.page);
      if (!page) throw new Error("标签页不属于当前会话或连接代次");
      if (action.action === "await_download")
        return {
          ...(await this.base("observed")),
          downloads: await this.files.wait(page.id, operation),
        };
      if (action.action === "batch") return this.batch(page, action, operation);
      const input =
        action.action === "navigate" ? { ...action, url: navigationUrl(action.url) } : action;
      const result = await page.execute(input, operation);
      if (action.action === "close") {
        this.pages.delete(page.id);
        await this.publish();
      }
      return { ...(await this.base(operation.dispatched ? "executed" : "observed")), ...result };
    } catch (error) {
      if (typeof value.page === "string" && operation.dispatched)
        this.pages.get(value.page)?.invalidate();
      return {
        ...(await this.base(operation.dispatched ? "unknown" : "not_executed")),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      };
    }
  }
  private async upload(
    value: Record<string, unknown>,
    operation: Operation,
  ): Promise<Record<string, unknown>> {
    if (this.human) throw new Error("用户持有控制权");
    if (typeof value.page !== "string") throw new Error("上传缺少页面");
    const page = this.pages.get(value.page);
    if (!page) throw new Error("上传页面不属于此会话");
    if (!Array.isArray(value.files) || value.files.length > 50) throw new Error("上传固定字节无效");
    let size = 0;
    const files = value.files.map((raw: unknown) => {
      const file = record(raw);
      if (
        typeof file.name !== "string" ||
        file.name.length > 8192 ||
        typeof file.mime_type !== "string" ||
        file.mime_type.length > 256 ||
        typeof file.data !== "string"
      )
        throw new Error("上传载荷字段无效");
      size += atob(file.data).length;
      if (size > 32 * 1024 * 1024) throw new Error("上传超过 32 MiB");
      return { name: file.name, mime_type: file.mime_type, data: file.data };
    });
    const observationMode = value.observation_mode;
    if (observationMode !== undefined && observationMode !== "full" && observationMode !== "delta" && observationMode !== "none")
      throw new Error("动作后观察模式必须是 full、delta 或 none");
    let target: { observation?: string; ref?: string; observation_mode?: "full" | "delta" | "none" } = { ...(observationMode === undefined ? {} : { observation_mode: observationMode }) };
    if (value.action === "upload_bytes") {
      if (typeof value.observation !== "string" || typeof value.ref !== "string")
        throw new Error("上传缺少观察和控件引用");
      target = { ...target, observation: value.observation, ref: value.ref };
    }
    return { ...(await this.base("executed")), ...(await page.upload(target, files, operation)) };
  }
  private async batch(
    page: ExtensionPage,
    action: Extract<BrowserAction, { action: "batch" }>,
    operation: Operation,
  ): Promise<Record<string, unknown>> {
    const steps: NonNullable<BrowserResult["steps"]> = [];
    for (const [index, step] of action.steps.entries()) {
      const before = operation.dispatched;
      operation.dispatched = false;
      try {
        await page.execute(
          { ...step, page: page.id, observation: action.observation },
          operation,
          false,
        );
        steps.push({ index, action: step.action, outcome: "executed" });
      } catch (error) {
        steps.push({
          index,
          action: step.action,
          outcome: operation.dispatched ? "unknown" : "not_executed",
          error: error instanceof Error ? error.message : String(error),
        });
        operation.dispatched ||= before;
        page.invalidate();
        return { ...(await this.base(operation.dispatched ? "unknown" : "not_executed")), steps };
      }
      operation.dispatched ||= before;
    }
    try {
      return {
        ...(await this.base("executed")),
        steps,
        ...(await page.afterObserved(action, operation)),
      };
    } catch (error) {
      return {
        ...(await this.base("executed")),
        steps,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  /** 永久关闭会话并取消排队动作；即使下载清理失败也逐一脱离标签页。
   * @returns 所有资源均已尝试清理；重复关闭复用同一结算。
   * @throws 任一资源未确认释放时返回聚合错误，不关闭用户浏览器进程。
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.human = true;
    this.lifetime.abort();
    this.closing = this.release();
    return this.closing;
  }
  private async release(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.files.close();
    } catch (error) {
      errors.push(error);
    }
    // 等待已经派发的创建和附着结算，再确认最后一批页面确实脱离控制。
    await this.queue;
    const results = await Promise.allSettled([...this.pages.values()].map((page) => page.detach()));
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    this.pages.clear();
    if (errors.length) throw new AggregateError(errors, "浏览器资源未完全释放");
  }
}
