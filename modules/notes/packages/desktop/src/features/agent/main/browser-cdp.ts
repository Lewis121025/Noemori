import { randomUUID } from "node:crypto";
import type { WebContents, WebContentsView } from "electron";
import type { WebSocket } from "ws";
import { record, text } from "../shared/parse";

/** 调试目标只来自本对话的网页视图；应用主界面不登记为浏览器目标。 */
type Target = { view: WebContentsView; info: Record<string, unknown>; session: string };
/** 浏览器级虚拟会话与页面原生会话分别寻址，不能选取本对话之外的目标。 */
type Session = { contents: WebContents; child?: string } | { browser: true };

/**
 * 将 Electron 的逐页调试连接交给现有浏览器执行器，不开放应用级调试端口。
 * 调用方持有视图、下载和连接生命周期；未知目标、损坏协议及已关闭页面会明确失败。
 */
export class BrowserCdp {
  private readonly targets = new Map<string, Target>();
  private readonly sessions = new Map<string, Session>();
  private readonly manualSessions = new Set<string>();
  private socket: WebSocket | null = null;
  private autoAttach = false;
  private closed = false;

  /**
   * @param anchor 本对话独占的不可见网页，承载同一 Session 的浏览器级命令。
   * @param create 仅为本对话创建真实网页视图。
   * @param browserCommand 处理本分区的 Cookie 与下载，不允许影响应用或其他对话。
   */
  constructor(
    private readonly anchor: WebContents,
    private readonly create: () => Promise<WebContentsView>,
    private readonly browserCommand: (method: string, params: Record<string, unknown>) => unknown,
  ) {
    anchor.debugger.attach("1.3");
  }

  /**
   * 绑定唯一自动化连接，重复连接直接关闭，协议错误通过 CDP 回执交付。
   * @param socket 已由宿主验证租约的 WebSocket；本方法不抛出协议解析异常。
   */
  connect(socket: WebSocket): void {
    if (this.socket !== null) {
      socket.close(1008, "浏览器已有控制连接");
      return;
    }
    this.socket = socket;
    socket.on("message", (bytes) => {
      void this.command(bytes.toString());
    });
    socket.once("close", () => {
      this.socket = null;
    });
  }

  /**
   * @param target 本对话登记的 CDP 页面身份。
   * @returns 对应真实网页视图。
   * @throws 页面未知或已销毁时拒绝，不回退到其他窗口。
   */
  view(target: string): WebContentsView {
    const item = this.targets.get(target);
    if (!item || item.view.webContents.isDestroyed()) throw new Error("浏览器页面已关闭");
    return item.view;
  }

  /**
   * @param url 用户从网页上下文菜单选择的链接。
   * @returns 在本浏览器分区创建并登记的真实页面身份。
   * @throws 视图创建、登记或导航失败时拒绝。
   */
  async open(url: string): Promise<string> {
    const { targetId } = await this.createTarget();
    await this.view(targetId).webContents.loadURL(url);
    return targetId;
  }

  /**
   * 下载和页面事件交付同一连接的所有浏览器订阅。
   * @param method CDP 事件名称。
   * @param params 宿主生成的事件参数；连接已关闭时无需发送，不抛出状态错误。
   */
  event(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
    for (const [sessionId, session] of this.sessions)
      if ("browser" in session) this.send({ sessionId, method, params });
  }

  /** 撤销调试连接与目标登记；原生页面由唯一视图所有者关闭，可重复调用。 */
  close(): void {
    this.closed = true;
    this.socket?.terminate();
    this.socket = null;
    this.targets.clear();
    this.sessions.clear();
    this.manualSessions.clear();
  }

  private send(value: Record<string, unknown>): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value));
  }

  private async command(raw: string): Promise<void> {
    let id: number | undefined;
    let sessionId: string | undefined;
    try {
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("浏览器控制帧超限");
      const item = record(JSON.parse(raw));
      if (typeof item["id"] !== "number" || !Number.isSafeInteger(item["id"]))
        throw new Error("浏览器控制编号无效");
      id = item["id"];
      const method = text(item, "method");
      if (item["sessionId"] !== undefined) sessionId = text(item, "sessionId");
      const params = item["params"] === undefined ? {} : record(item["params"]);
      const result = await this.execute(method, params, sessionId);
      this.send({ id, sessionId, result });
    } catch (reason) {
      if (id === undefined) this.socket?.close(1008, "浏览器控制协议无效");
      else
        this.send({
          id,
          sessionId,
          error: {
            code: -32000,
            message: reason instanceof Error ? reason.message : String(reason),
          },
        });
    }
  }

  private async execute(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (sessionId !== undefined && !session) throw new Error("调试会话不属于本对话");
    // 逐页会话同样不能回退到 Chromium 的应用默认存储分区。
    if (
      method.startsWith("Storage.") ||
      method === "Browser.setDownloadBehavior" ||
      method === "Browser.cancelDownload"
    )
      return this.browserCommand(method, params);
    if (method === "Target.getTargets") {
      const targetInfos = await Promise.all(
        [...this.targets.values()].map(async (target) => {
          const result: unknown =
            await target.view.webContents.debugger.sendCommand("Target.getTargetInfo");
          return record(record(result)["targetInfo"]);
        }),
      );
      return { targetInfos };
    }
    if (method === "Target.attachToBrowserTarget") {
      const sessionId = randomUUID();
      this.sessions.set(sessionId, { browser: true });
      return { sessionId };
    }
    if (method === "Target.setAutoAttach") {
      if (session && "contents" in session)
        return session.contents.debugger.sendCommand(method, params, session.child);
      this.autoAttach = params["autoAttach"] === true;
      if (this.autoAttach) for (const target of this.targets.values()) this.attach(target);
      return {};
    }
    if (method === "Target.getTargetInfo") {
      if (params["targetId"] !== undefined)
        return this.view(text(params, "targetId")).webContents.debugger.sendCommand(method, params);
      if (session && "contents" in session)
        return session.contents.debugger.sendCommand(method, params, session.child);
      return {
        targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true },
      };
    }
    if (method === "Target.createTarget") return this.createTarget();
    if (method === "Target.attachToTarget") {
      const target = this.targets.get(text(params, "targetId"));
      if (!target) throw new Error("调试目标不属于本对话");
      const response: unknown = await target.view.webContents.debugger.sendCommand(method, params);
      const child = text(record(response), "sessionId");
      this.sessions.set(child, { contents: target.view.webContents, child });
      this.manualSessions.add(child);
      this.send({
        sessionId,
        method: "Target.attachedToTarget",
        params: { sessionId: child, targetInfo: target.info, waitingForDebugger: false },
      });
      return response;
    }
    if (method === "Target.detachFromTarget") {
      const id = text(params, "sessionId");
      const session = this.sessions.get(id);
      if (!session) throw new Error("调试会话不属于本对话");
      if ("contents" in session && session.child)
        await session.contents.debugger.sendCommand(method, params);
      this.sessions.delete(id);
      this.send({ sessionId, method: "Target.detachedFromTarget", params: { sessionId: id } });
      return {};
    }
    if (method === "Target.closeTarget") {
      this.view(text(params, "targetId")).webContents.close();
      return { success: true };
    }
    if (method === "Browser.getVersion") return this.anchor.debugger.sendCommand(method, params);
    // 页面会话也是宿主边界，浏览器级能力必须先经目标与分区校验。
    if (method.startsWith("Target.") || method.startsWith("Browser."))
      throw new Error(`浏览器级命令未开放：${method}`);
    if (session && "contents" in session)
      return session.contents.debugger.sendCommand(method, params, session.child);
    throw new Error(`浏览器级命令未开放：${method}`);
  }

  private async createTarget(): Promise<{ targetId: string }> {
    if (this.targets.size >= 12) throw new Error("浏览器标签页达到会话上限");
    const view = await this.create();
    try {
      await view.webContents.loadURL("about:blank");
      return { targetId: await this.adopt(view) };
    } catch (error) {
      // 调试登记前失败的页面仍是本次创建的资源，不能留给后续连接或窗口销毁兜底。
      if (!view.webContents.isDestroyed()) view.webContents.close();
      throw error;
    }
  }

  /**
   * 接入原生弹出页面，保留 opener、同源关系和已有导航。
   * @param view Electron 已创建的真实网页对象，调用方持有其生命周期。
   * @returns 本对话内登记的 CDP 页面身份。
   * @throws 页面超过上限、调试连接或目标信息读取失败时拒绝。
   */
  async adopt(view: WebContentsView): Promise<string> {
    if (this.closed) throw new Error("浏览器已关闭");
    if (this.targets.size >= 12) throw new Error("浏览器标签页达到会话上限");
    const contents = view.webContents;
    contents.debugger.attach("1.3");
    const response: unknown = await contents.debugger.sendCommand("Target.getTargetInfo");
    if (this.closed) throw new Error("浏览器已关闭");
    const info = record(record(response)["targetInfo"]);
    const targetId = text(info, "targetId");
    const target = { view, info, session: randomUUID() };
    this.targets.set(targetId, target);
    this.sessions.set(target.session, { contents });
    contents.debugger.on("message", (_event, method, raw, child) => {
      const params = record(raw);
      // 手动附着本页的回执由对应浏览器会话交付，不能误识别成页面的子框架。
      if (method === "Target.attachedToTarget") {
        if (record(params["targetInfo"])["targetId"] === targetId) return;
        const sessionId = text(params, "sessionId");
        this.sessions.set(sessionId, { contents, child: sessionId });
      }
      if (method === "Target.detachedFromTarget") {
        const id = text(params, "sessionId");
        if (this.manualSessions.delete(id)) return;
      }
      this.send({ sessionId: child || target.session, method, params });
    });
    contents.once("destroyed", () => {
      this.targets.delete(targetId);
      for (const [id, session] of this.sessions)
        if ("contents" in session && session.contents === contents) this.sessions.delete(id);
      this.event("Target.detachedFromTarget", { sessionId: target.session, targetId });
    });
    if (this.autoAttach) this.attach(target);
    return targetId;
  }

  private attach(target: Target): void {
    this.send({
      method: "Target.attachedToTarget",
      params: { sessionId: target.session, targetInfo: target.info, waitingForDebugger: false },
    });
  }
}
