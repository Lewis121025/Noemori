import { randomUUID } from "node:crypto";
import type { Proxy } from "../contract.js";

/** 代理认证只通过私有控制管道交给网络出口；每个来源由 Rust 解析系统代理与 NO_PROXY。 */
export class BrowserProxyResolver {
  private readonly pending = new Map<
    string,
    { resolve(value: Proxy | undefined): void; reject(error: Error): void }
  >();
  private readonly origins = new Map<string, Promise<Proxy | undefined>>();

  /** @param write 宿主私有控制通道的写入入口；凭据不得输出到模型观察或普通日志。 */
  constructor(private readonly write: (frame: unknown) => Promise<void>) {}

  /**
   * 为目标来源取得冻结配置；失败不回退为直连，超时和关闭均拒绝等待。
   * @param source 正在请求的目标网络地址，同来源复用已取得的代理配置。
   * @returns 代理配置；undefined 表示宿主明确选择直连。
   * @throws 地址无效、来源数量超限、控制通道失败、宿主拒绝、超时或关闭。
   */
  resolve(source: string): Promise<Proxy | undefined> {
    const origin = new URL(source).origin;
    const previous = this.origins.get(origin);
    if (previous) return previous;
    if (this.origins.size >= 512) return Promise.reject(new Error("浏览器目标来源超过会话上限"));
    const id = randomUUID();
    const result = new Promise<Proxy | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("系统代理解析超时"));
      }, 10000);
      this.pending.set(id, {
        resolve: (proxy) => {
          clearTimeout(timer);
          resolve(proxy);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      void this.write({ kind: "proxy_request", id, url: source }).catch((error: unknown) => {
        this.pending
          .get(id)
          ?.reject(new Error(error instanceof Error ? error.message : "代理控制通道中断"));
        this.pending.delete(id);
      });
    });
    this.origins.set(origin, result);
    return result;
  }

  /**
   * 只接受尚在等待的回复；凭据不向浏览器页面或模型返回。
   * @param frame 宿主返回的代理结果；字段仍须校验，不能直接转换为 Proxy。
   * @returns 完成对应等待；迟到回复忽略，无效代理作为请求失败结算。
   * @throws 回复缺少字符串标识时抛出协议错误。
   */
  accept(frame: Record<string, unknown>): void {
    if (typeof frame.id !== "string") throw new Error("代理回复缺少标识");
    const request = this.pending.get(frame.id);
    if (!request) return;
    this.pending.delete(frame.id);
    if (typeof frame.error === "string") {
      request.reject(new Error(frame.error));
      return;
    }
    const proxy = frame.proxy;
    if (proxy === null) {
      request.resolve(undefined);
      return;
    }
    if (
      typeof proxy !== "object" ||
      !proxy ||
      !("server" in proxy) ||
      typeof proxy.server !== "string"
    ) {
      request.reject(new Error("系统代理回复无效"));
      return;
    }
    const value: Proxy = { server: proxy.server, resolve_hostname: true };
    if ("username" in proxy && typeof proxy.username === "string") value.username = proxy.username;
    if ("password" in proxy && typeof proxy.password === "string") value.password = proxy.password;
    request.resolve(value);
  }

  /** @returns 拒绝并释放所有未完成解析后立即返回；调用方必须结算已有请求 Promise。 */
  close(): void {
    for (const request of this.pending.values()) request.reject(new Error("浏览器代理通道已关闭"));
    this.pending.clear();
  }
}
