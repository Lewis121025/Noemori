import { createInterface } from "node:readline";
import type { HtmlSnapshot, ReadResult } from "./contract.js";
import { ControlOutput } from "./output.js";

/** 宿主持有的浏览器租约；调试地址只用于辅助程序内部控制，不进入模型结果。 */
export type BrowserLease = { endpoint: string; pid: number };

/** 辅助程序只请求分配资源，进程创建和最终回收由 Rust 宿主负责。 */
export class HostChannel {
  private readonly lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  private readonly reader = this.lines[Symbol.asyncIterator]();
  private readonly output = new ControlOutput(process.stdout);

  /** 输出失败会终结控制输入；资源释放仍由正在执行的操作负责。 */
  constructor() {
    this.output.signal.addEventListener("abort", () => this.close(), { once: true });
  }

  /** 读取一条完整控制消息；宿主提前结束或 JSON 无效时抛出具体错误。 */
  async read(): Promise<unknown> {
    const line = await this.reader.next();
    if (this.output.error) throw this.output.error;
    if (line.done) throw new Error("宿主输入已关闭");
    if (Buffer.byteLength(line.value) > 68 * 1024 * 1024) throw new Error("宿主输入超过字节上限");
    return JSON.parse(line.value);
  }

  /**
   * 请求宿主创建浏览器；只有资源已归宿主持有后才返回。
   * @param executable 已解析的浏览器路径，显式宿主配置优先。
   * @param proxyUrl 当前操作的受控本地网络出口。
   * @returns 浏览器控制地址与进程标识。
   * @throws 回复无效或宿主未分配浏览器时抛出错误。
   */
  async startBrowser(executable: string, proxyUrl: string): Promise<BrowserLease> {
    await this.write({ kind: "browser_start", executable, proxy_url: proxyUrl });
    const value = await this.read();
    if (
      typeof value !== "object" ||
      value === null ||
      !("kind" in value) ||
      value.kind !== "browser_ready" ||
      !("endpoint" in value) ||
      typeof value.endpoint !== "string" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    ) {
      throw new Error("宿主没有返回有效浏览器租约");
    }
    return { endpoint: value.endpoint, pid: value.pid };
  }

  /** 完整结果按一条控制帧提交，图像仍留在有类型的结果字段内。 */
  async finish(result: ReadResult): Promise<void> {
    await this.write({ kind: "finished", result });
  }

  /** 搜索 HTML 使用独立帧类型，宿主只能把解析后的标题、摘要和链接提交给模型。 */
  async finishSearch(result: HtmlSnapshot): Promise<void> {
    await this.write({ kind: "search_finished", result });
  }

  /** 失败提交明确原因；输出已失效时经 stderr 诊断，调用方必须结束会话。 */
  async fail(reason: string): Promise<void> {
    await this.output.reportFailure(reason);
  }

  /** 停止控制输入读取，使单次辅助进程能正常退出。 */
  close(): void {
    this.lines.close();
    process.stdin.destroy();
  }

  private async write(value: unknown): Promise<void> {
    await this.output.write(value);
  }
}
