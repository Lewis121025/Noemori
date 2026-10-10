import type { BrowserPage } from "./observation.js";
import { navigationUrl, record } from "./contract.js";

/** 只接受明确成功证据；普通跳转、空闲或控件消失均不能证明用户已经完成。 */
export type HandoffCondition = { type: "url"; url: string } | { type: "text"; text: string };
/** 协助绑定真实页面；网页内容不能更改本次完成条件。 */
export type HandoffRequest = { page: string; until: HandoffCondition };
/** 等待与结算共用身份；失败保留原因，不能伪装成成功。 */
export type HandoffState = { id: string; page: string; status: "waiting" | "completed" | "failed" | "cancelled"; error: string | null };

function text(input: Record<string, unknown>, key: string, maximum = 8192): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`协助条件 ${key} 无效`);
  return value;
}

/** 校验有界完成条件，返回规范 URL 或精确文字；无效条件抛出输入错误。 */
export function parseHandoff(value: unknown): HandoffRequest {
  const request = record(value);
  const until = record(request.until);
  if (Object.keys(request).some((key) => !["page", "until"].includes(key))) throw new Error("协助请求含未知字段");
  const type = text(until, "type", 16);
  if (Object.keys(until).some((key) => !["type", type].includes(key))) throw new Error("协助条件含未知字段");
  const page = text(request, "page", 128);
  if (type === "url") return { page, until: { type, url: navigationUrl(text(until, "url")) } };
  if (type === "text") return { page, until: { type, text: text(until, "text", 4096) } };
  throw new Error("协助需要明确的成功地址或成功提示");
}

/**
 * 读取一次成功证据，不派发输入；导航中的暂态只表示尚未完成。
 * @param entry 当前协助页面。
 * @param until 冻结的成功条件。
 * @returns 当前文档完全加载且条件满足时为 true。
 * @throws 页面关闭、崩溃或不可恢复的读取错误。
 */
export async function handoffComplete(entry: BrowserPage, until: HandoffCondition): Promise<boolean> {
  if (entry.page.isClosed()) throw new Error("协助页面已关闭");
  if (entry.crashed) throw new Error("协助页面已退出");
  if (entry.dialog || entry.fileChooser) return false;
  try {
    return await entry.guard(async () => {
      if (await entry.page.evaluate(() => document.readyState) !== "complete") return false;
      if (until.type === "url") return entry.page.url() === until.url;
      for (const frame of entry.page.frames()) {
        if (frame.isDetached()) continue;
        for (const match of await frame.getByText(until.text, { exact: true }).all()) {
          if (await match.isVisible()) return true;
        }
      }
      return false;
    }, { timeout: 3000 });
  } catch (error) {
    if (entry.dialog || entry.fileChooser) return false;
    if (!entry.page.isClosed() && error instanceof Error && /Execution context was destroyed|Cannot find context with specified id|Frame was detached/.test(error.message)) return false;
    throw error;
  }
}

/** 单次协助拥有独立观察生命周期；替换、交还和关闭都会撤销迟到读取。 */
export class BrowserHandoff {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private matchingSince: number | null = null;
  readonly state: HandoffState;

  /** 只构造等待状态；调用 watch 后才开始观察，不派发网页输入。 */
  constructor(private readonly entry: BrowserPage, private readonly until: HandoffCondition, private readonly changed: () => void) {
    this.state = { id: globalThis.crypto.randomUUID(), page: entry.id, status: "waiting", error: null };
  }

  /** 开始有界的逐次观察；同一时间最多读取一次，结果稳定后通知宿主，不自行恢复模型。 */
  watch(): void {
    this.timer = setTimeout(() => void this.check(), 250);
  }

  private async check(): Promise<void> {
    try {
      const matched = await handoffComplete(this.entry, this.until);
      if (this.disposed) return;
      if (!matched) this.matchingSince = null;
      else if (this.matchingSince === null) this.matchingSince = performance.now();
      else if (performance.now() - this.matchingSince >= 500) {
        this.state.status = "completed";
        this.changed();
        return;
      }
    } catch (error) {
      if (this.disposed) return;
      this.state.status = "failed";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.changed();
      return;
    }
    if (!this.disposed) this.watch();
  }

  /** 撤销当前观察；已发出的异步读取可以结算，但不能再写状态或通知。 */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
