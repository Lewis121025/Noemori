import type { BrowserContext, Page } from "playwright-core";
import { findText, interact, readText, waitForText, type BrowserExecution } from "./actions.js";
import { BrowserFiles } from "./files.js";
import { BrowserPage, reason } from "./observation.js";
import { releaseBrowserResources } from "./lifecycle.js";
import {
  navigationUrl,
  parseAction,
  type BrowserAction,
  type BrowserResult,
  type BrowserSettings,
  type TabState,
} from "./contract.js";

/** 一条会话的浏览器执行器；命令串行结算，取消等待不会偷偷开启下一条动作。 */
export class BrowserEngine {
  readonly files: BrowserFiles;
  private readonly pages = new Map<string, BrowserPage>();
  private activePage: BrowserPage | undefined;
  private tabRevision = 0;
  private mode: "agent" | "human" = "agent";
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * 绑定宿主独占的上下文，登记现有及后续标签页；系统权限由宿主创建上下文时限制。
   * @param context 一条会话独占的浏览器上下文，调用方负责提供权限边界。
   * @param settings 已验证的工作区与资源预算。
   * @param grantOrigin 宿主审批完成后的网络授权入口，不得由网页内容触发。
   * @param changed 状态通知，必须快速返回且不得抛出异常。
   */
  constructor(
    private readonly context: BrowserContext,
    private readonly settings: BrowserSettings,
    private readonly grantOrigin?: (origin: string) => void,
    private readonly changed: (tabs: TabState[]) => void = () => {},
  ) {
    this.files = new BrowserFiles(settings);
    for (const page of context.pages()) this.track(page);
    context.on("page", (page) => this.track(page));
  }

  /**
   * 枚举同一会话的活页面；对话框内容保留为待处理观察，不自动接受。
   * @returns 页面元数据的独立数组，不暴露浏览器对象或调试连接。
   */
  tabs(): TabState[] {
    return [...this.pages.values()].map((entry) => ({
      id: entry.id,
      url: entry.page.url(),
      title: entry.observation?.title || "",
      crashed: entry.crashed,
      file_chooser: entry.fileChooser !== null,
      dialog: entry.dialog,
    }));
  }

  private track(page: Page): void {
    if ([...this.pages.values()].some((entry) => entry.page === page)) return;
    if (this.closed || this.pages.size >= this.settings.max_pages) {
      void page.close();
      return;
    }
    const entry = new BrowserPage(page, () => this.changed(this.tabs()));
    this.pages.set(entry.id, entry);
    this.tabRevision++;
    page.on("close", () => {
      this.pages.delete(entry.id);
      this.tabRevision++;
      if (this.activePage === entry) this.activePage = undefined;
      void entry.invalidate();
      this.changed(this.tabs());
    });
    const publish = () => this.changed(this.tabs());
    page.on("framenavigated", publish);
    page.on("crash", publish);
    page.on("filechooser", publish);
    page.on("download", (download) => this.files.receive(download));
    this.changed(this.tabs());
  }

  /**
   * 排队执行动作，同一会话不交错发送输入。
   * @param action 已校验动作；页面与观察必须属于本执行器。
   * @param signal 当前工具的取消信号，不能撤销已经发给网页的操作。
   * @param timeout 包括排队等待在内的毫秒预算。
   * @returns 实际执行阶段及观察；业务目标仍须根据页面结果核验。
   * @throws 无法完成资源回收等基础设施异常；普通操作失败保留在结果中。
   */
  execute(action: BrowserAction, signal: AbortSignal, timeout: number): Promise<BrowserResult> {
    const deadline = performance.now() + timeout;
    const operation = this.queue.then(() => this.perform(action, signal, deadline));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private base(outcome: BrowserResult["outcome"]): BrowserResult {
    return { outcome, tabs: this.tabs(), mode: this.mode };
  }

  /**
   * IPC 参数错误属于可纠正的操作错误，不应摧毁仍有效的登录态和标签页。
   * @param value 宿主传来的未知 JSON 动作。
   * @param signal 本轮取消信号。
   * @param timeout 本次调用的剩余毫秒预算。
   * @returns 校验失败时返回 not_executed，否则沿用 execute 的执行回执。
   * @throws 沿用 execute 的基础设施异常。
   */
  dispatch(value: unknown, signal: AbortSignal, timeout: number): Promise<BrowserResult> {
    try {
      return this.execute(parseAction(value), signal, timeout);
    } catch (error) {
      return Promise.resolve({ ...this.base("not_executed"), error: reason(error) });
    }
  }

  private async perform(
    action: BrowserAction,
    signal: AbortSignal,
    deadline: number,
  ): Promise<BrowserResult> {
    let dispatched = false;
    const execution: BrowserExecution = {
      signal,
      check: () => {
        if (this.closed) throw new Error("浏览器会话已关闭");
        if (signal.aborted) throw new Error("浏览器操作已取消");
        if (performance.now() >= deadline) throw new Error("浏览器操作已超时");
      },
      budget: () => Math.max(1, Math.min(10000, deadline - performance.now())),
      dispatch: () => {
        execution.check();
        dispatched = true;
      },
    };
    try {
      execution.check();
      return await this.route(action, execution);
    } catch (error) {
      if (dispatched && "page" in action) await this.pages.get(action.page)?.invalidate();
      return { ...this.base(dispatched ? "unknown" : "not_executed"), error: reason(error) };
    }
  }

  private async route(action: BrowserAction, execution: BrowserExecution): Promise<BrowserResult> {
    if (action.action === "allow_origin") {
      if (!this.grantOrigin) throw new Error("运行时不支持变更网络来源");
      this.grantOrigin(action.origin);
      return this.base("executed");
    }
    if (action.action === "tabs") return this.base("observed");
    if (action.action === "downloads")
      return { ...this.base("observed"), downloads: this.files.states() };
    if (action.action === "handoff" || action.action === "resume") {
      const mode = action.action === "handoff" ? "human" : "agent";
      if (this.mode === mode) return this.base("executed");
      await Promise.all([...this.pages.values()].map((entry) => entry.dialogs.ready()));
      await Promise.all([...this.pages.values()].map((entry) => entry.invalidate()));
      this.mode = mode;
      if (this.mode === "human")
        await (this.activePage ?? this.pages.values().next().value)?.page.bringToFront();
      return this.base("executed");
    }
    if (this.mode === "human") throw new Error("浏览器已交给用户，交还控制前不能执行 Agent 命令");
    if (action.action === "save_download") {
      execution.dispatch();
      return {
        ...this.base("executed"),
        saved_path: await this.files.save(action.id, action.path),
      };
    }
    if (action.action === "open") return this.open(action.url, execution);
    const entry = this.pages.get(action.page);
    if (!entry || entry.page.isClosed()) throw new Error("标签页不属于当前会话或已关闭");
    this.activePage = entry;
    return this.pageAction(entry, action, execution);
  }

  private async open(source: string, execution: BrowserExecution): Promise<BrowserResult> {
    const url = navigationUrl(source);
    if (this.pages.size >= this.settings.max_pages) throw new Error("浏览器标签页达到会话上限");
    execution.dispatch();
    const page = await this.context.newPage();
    const entry = [...this.pages.values()].find((entry) => entry.page === page);
    if (!entry) throw new Error("新标签页在导航期间关闭");
    this.activePage = entry;
    await entry.guard(
      (signal) =>
        page.goto(url, { waitUntil: "domcontentloaded", timeout: execution.budget(), signal }),
      { timeout: execution.budget(), signal: execution.signal },
    );
    return this.observed(entry, false, "executed", execution);
  }

  private async pageAction(
    entry: BrowserPage,
    action: Extract<BrowserAction, { page: string }>,
    execution: BrowserExecution,
  ): Promise<BrowserResult> {
    const page = entry.page;
    await entry.dialogs.ready();
    if (entry.dialog && action.action !== "dialog" && action.action !== "close")
      throw new Error("先处理页面对话框，再继续操作");
    if (action.action === "observe" || action.action === "screenshot")
      return this.observed(entry, action.action === "screenshot", "observed", execution);
    if (action.action === "read")
      return {
        ...this.base("observed"),
        text_page: await readText(entry, action.offset, this.settings.max_chars, execution),
      };
    switch (action.action) {
      case "batch":
        return this.batch(entry, action, execution);
      case "dialog": {
        if (!entry.dialog) throw new Error("页面没有待处理的对话框");
        execution.dispatch();
        await entry.dialogs.reply(action.accept, action.text);
        break;
      }
      case "close":
        execution.dispatch();
        await page.close();
        return this.base("executed");
      case "find": {
        const target = await findText(entry, action.text, action.exact ?? true);
        execution.dispatch();
        await entry.guard(
          (signal) => target.scrollIntoViewIfNeeded({ timeout: execution.budget(), signal }),
          {
            signal: execution.signal,
            timeout: execution.budget(),
          },
        );
        break;
      }
      case "choose_files": {
        if (!entry.fileChooser) throw new Error("页面没有待处理文件选择器");
        const files = await this.files.upload(action.paths);
        execution.dispatch();
        const chooser = entry.fileChooser;
        await entry.guard(
          (signal) => chooser.setFiles(files, { timeout: execution.budget(), signal }),
          {
            signal: execution.signal,
            timeout: execution.budget(),
          },
        );
        entry.fileChooser = null;
        break;
      }
      case "wait": {
        await waitForText(entry, action.text, action.state, action.exact ?? true, execution);
        execution.check();
        return this.observed(entry, false, "observed", execution);
      }
      case "navigate": {
        const url = navigationUrl(action.url);
        execution.dispatch();
        await entry.guard(
          (signal) =>
            page.goto(url, { waitUntil: "domcontentloaded", timeout: execution.budget(), signal }),
          { signal: execution.signal, timeout: execution.budget() },
        );
        break;
      }
      case "back":
      case "forward":
      case "reload": {
        execution.dispatch();
        const options = { waitUntil: "domcontentloaded", timeout: execution.budget() } as const;
        await entry.guard(
          async (signal) => {
            if (action.action === "back") await page.goBack({ ...options, signal });
            else if (action.action === "forward") await page.goForward({ ...options, signal });
            else await page.reload({ ...options, signal });
          },
          { signal: execution.signal, timeout: execution.budget() },
        );
        break;
      }
      default:
        await interact(entry, action, this.files, execution);
    }
    // 弹窗需要先交给模型或用户处理，此时不能继续调用会被阻塞的页面观察。
    if (entry.dialog || page.isClosed()) return this.base("executed");
    execution.check();
    return this.observed(entry, false, "executed", execution);
  }

  private async observed(
    entry: BrowserPage,
    image: boolean,
    outcome: BrowserResult["outcome"],
    execution: BrowserExecution,
  ): Promise<BrowserResult> {
    const observation = await entry.observe(this.settings, image, execution.check);
    return { ...this.base(outcome), ...observation, downloads: this.files.states() };
  }

  private async batch(
    entry: BrowserPage,
    action: Extract<BrowserAction, { action: "batch" }>,
    execution: BrowserExecution,
  ): Promise<BrowserResult> {
    const steps: NonNullable<BrowserResult["steps"]> = [];
    const tabRevision = this.tabRevision;
    try {
      for (const [index, step] of action.steps.entries()) {
        execution.check();
        let dispatched = false;
        const local = {
          ...execution,
          dispatch: () => {
            if (this.tabRevision !== tabRevision)
              throw new Error("标签页集合已改变，未执行剩余批量步骤");
            execution.dispatch();
            dispatched = true;
          },
        };
        try {
          await interact(
            entry,
            { ...step, page: action.page, observation: action.observation },
            this.files,
            local,
          );
          steps.push({ index, action: step.action, outcome: "executed" });
        } catch (error) {
          steps.push({
            index,
            action: step.action,
            outcome: dispatched ? "unknown" : "not_executed",
            error: reason(error),
          });
          throw error;
        }
        if (entry.dialog && index + 1 < action.steps.length)
          throw new Error("页面已打开对话框，未执行剩余批量步骤");
      }
      if (entry.dialog || entry.page.isClosed()) return { ...this.base("executed"), steps };
      return { ...(await this.observed(entry, false, "executed", execution)), steps };
    } catch (error) {
      await entry.invalidate();
      return {
        ...this.base(
          steps.some((step) => step.outcome !== "not_executed") ? "unknown" : "not_executed",
        ),
        steps,
        error: `批量操作停止；请根据逐步回执检查状态，不要重放已执行步骤。${reason(error)}`,
      };
    }
  }

  /**
   * 停止接受新命令，关闭上下文以中断等待，随后结算队列和文件任务。
   * @returns 所有释放步骤成功后完成。
   * @throws AggregateError 汇集清理失败；单个失败仍继续释放后续资源。
   */
  async close(): Promise<void> {
    this.closed = true;
    await releaseBrowserResources([
      () => this.context.close(),
      () => this.queue,
      () => this.files.close(),
    ]);
  }
}
