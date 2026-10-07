import type { CDPSession, Page } from "playwright-core";
import type { TabState } from "./contract.js";

/** 同一协议会话维护弹窗打开与关闭，人工关闭也必须更新状态。 */
export class BrowserDialogs {
  current: TabState["dialog"] = null;
  private session: CDPSession | undefined;
  private failure: Error | undefined;
  private listening = false;
  private readonly listeners = new Set<() => void>();
  private readonly binding: Promise<void>;

  /**
   * 监听页面弹窗以阻止 Playwright 自动取消；订阅就绪前保留已出现的弹窗。
   * @param page 当前会话内的页面。
   * @param changed 弹窗状态变化通知，必须快速返回且不得抛出异常。
   * @throws 协议订阅的异步错误留到 ready 调用报告。
   */
  constructor(
    private readonly page: Page,
    private readonly changed: () => void,
  ) {
    page.on("dialog", (dialog) => {
      if (!this.listening) this.update({ type: dialog.type(), message: dialog.message() });
    });
    this.binding = this.bind().catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
  }

  private async bind(): Promise<void> {
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on("Page.javascriptDialogOpening", (event) =>
      this.update({ type: event.type, message: event.message }),
    );
    this.session.on("Page.javascriptDialogClosed", () => this.update(null));
    await this.session.send("Page.enable");
    this.listening = true;
  }

  private update(dialog: TabState["dialog"]): void {
    this.current =
      dialog === null ? null : { type: dialog.type, message: dialog.message.slice(0, 2000) };
    for (const listener of this.listeners) listener();
    this.changed();
  }

  /**
   * 等待监视器就绪；订阅失败明确阻止操作，不能在未知状态下继续输入。
   * @returns 浏览器确认订阅生效后完成。
   * @throws 页面关闭、协议连接失败或订阅失败。
   */
  async ready(): Promise<void> {
    await this.binding;
    if (this.failure) throw this.failure;
  }

  /**
   * 登记当前操作的中断监听，不持有额外浏览器资源。
   * @param listener 同步快速返回且不抛出异常的状态回调。
   * @returns 幂等的取消订阅入口；调用者须在操作结算后释放监听。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 回复当前弹窗；关闭事件由浏览器确认，不能误清除随后打开的新弹窗。
   * @param accept 是否接受当前弹窗。
   * @param text prompt 类型的可选输入。
   * @returns 浏览器收到回复后完成，随后出现的弹窗仍保留为待处理状态。
   * @throws 弹窗已不存在、监视器不可用或协议发送失败。
   */
  async reply(accept: boolean, text?: string): Promise<void> {
    await this.ready();
    if (!this.session || !this.current) throw new Error("页面没有待处理的对话框");
    await this.session.send("Page.handleJavaScriptDialog", {
      accept,
      ...(text === undefined ? {} : { promptText: text }),
    });
  }
}
