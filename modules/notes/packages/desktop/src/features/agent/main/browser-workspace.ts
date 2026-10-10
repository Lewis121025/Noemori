import {
  WebContentsView,
  webContents,
  session,
  dialog,
  Menu,
  clipboard,
  type BrowserWindow,
  type DownloadItem,
  type Rectangle,
  type WebContents,
} from "electron";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { BrowserCdp } from "./browser-cdp";
import { record, text } from "../shared/parse";
import type { BrowserDownload, BrowserViewPlacement } from "../shared/browser";

/** 用户可保存的下载始终引用本会话已有 DownloadItem，不接受任意文件路径。 */
type Download = { item: DownloadItem; view: BrowserDownload };

/**
 * 一条对话的真实网页工作区；网页、登录分区与下载归此对象统一回收。
 * 主进程管理显示和原生输入，Node 执行器通过私有租约连接相同网页。
 */
export class BrowserWorkspace {
  readonly ready: Promise<string>;
  private readonly http: Server;
  private readonly websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });
  private readonly partition;
  private readonly anchor: WebContentsView;
  private readonly shield: WebContentsView;
  private readonly bridge: BrowserCdp;
  private readonly views = new Set<WebContentsView>();
  private readonly downloads = new Map<string, Download>();
  private readonly token = randomUUID();
  private active: WebContentsView | null = null;
  private placement: BrowserViewPlacement | null = null;
  private downloadDirectory: string | null = null;
  private closed = false;
  private lease: "available" | "allocating" | "ready" = "available";
  private human = false;

  /**
   * @param window 网页所属的应用窗口。
   * @param id 已保存对话身份，用于隔离登录会话。
   * @param changed 仅通知下载和焦点变化，不携带网页私密内容。
   * @throws 无法创建网页分区或本地监听时 ready 拒绝，不向模型降级为其他浏览器。
   */
  constructor(
    private readonly window: BrowserWindow,
    id: string,
    private readonly changed: () => void,
  ) {
    this.partition = session.fromPartition(`persist:noemori-browser-${id}`);
    this.anchor = new WebContentsView({ webPreferences: this.preferences() });
    this.shield = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.shield.setBackgroundColor("#00000000");
    this.window.contentView.addChildView(this.shield);
    this.shield.setVisible(false);
    void this.shield.webContents.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          '<html><body style="margin:0;background:transparent;height:100vh"></body></html>',
        ),
    );
    this.bridge = new BrowserCdp(
      this.anchor.webContents,
      async () => this.createView(),
      (method, params) => this.browserCommand(method, params),
    );
    this.partition.setPermissionRequestHandler((contents, permission, respond) => {
      if (!this.human || ![...this.views].some((view) => view.webContents === contents)) {
        respond(false);
        return;
      }
      void dialog
        .showMessageBox(this.window, {
          type: "question",
          title: "网页权限",
          message: `${new URL(contents.getURL()).origin} 请求 ${permission} 权限`,
          buttons: ["拒绝", "允许"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(
          (reply) => respond(reply.response === 1 && !this.closed && this.human),
          () => respond(false),
        );
    });
    this.partition.on("will-download", this.download);
    this.http = createServer((request, response) => {
      void (async () => {
        if (
          this.closed ||
          request.method !== "POST" ||
          request.url !== `/${this.token}/lease` ||
          this.lease !== "available"
        ) {
          response.writeHead(403).end();
          return;
        }
        // 异步读取和代理设置前先占住申请边界，两个请求不能同时发布同一浏览器。
        this.lease = "allocating";
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of request) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += bytes.length;
          if (size > 16384) throw new Error("浏览器租约请求超限");
          parts.push(bytes);
        }
        const body = record(JSON.parse(Buffer.concat(parts).toString()));
        const proxy = new URL(text(body, "proxy"));
        if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1")
          throw new Error("浏览器出口不是宿主本地网关");
        const directory = text(body, "downloads");
        if (!isAbsolute(directory)) throw new Error("浏览器下载目录无效");
        await this.partition.setProxy({
          mode: "fixed_servers",
          proxyRules: proxy.origin,
          proxyBypassRules: "<-loopback>",
        });
        if (this.closed) throw new Error("浏览器已关闭");
        this.downloadDirectory = directory;
        this.lease = "ready";
        const url = new URL(await this.ready);
        url.protocol = "ws:";
        url.pathname = `/${this.token}/cdp`;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ endpoint: url.href }));
      })().catch((error: unknown) => {
        if (!this.closed) this.lease = "available";
        response
          .writeHead(400, { "content-type": "text/plain" })
          .end(error instanceof Error ? error.message : String(error));
      });
    });
    this.http.on("upgrade", (request, socket, head) => {
      if (this.closed || this.lease !== "ready" || request.url !== `/${this.token}/cdp`) {
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (client) => this.bridge.connect(client));
    });
    this.ready = new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        const address = this.http.address();
        if (!address || typeof address === "string") reject(new Error("浏览器监听地址无效"));
        else resolve(`http://127.0.0.1:${address.port}/${this.token}/lease`);
      });
    });
  }

  /**
   * 更新真实网页位置，切换页面保留网页与登录状态。
   * @param target 本对话登记的真实目标身份。
   * @param placement 主框架计算的矩形与控制状态。
   * @throws 页面已关闭或原生显示失败时拒绝。
   */
  show(target: string, placement: BrowserViewPlacement): void {
    const view = this.bridge.view(target);
    if (this.active !== view) this.active?.setVisible(false);
    this.active = view;
    this.placement = placement;
    this.setHuman(placement.human);
    view.setBounds(this.bounds(placement.bounds));
    view.setVisible(true);
    this.shield.setBounds(this.bounds(placement.bounds));
    this.window.contentView.removeChildView(this.shield);
    this.window.contentView.addChildView(this.shield);
    this.shield.setVisible(!this.human);
  }

  /** 用户离开页面只隐藏视图，后台 Agent 仍操作同一页面。 */
  hide(): void {
    if (this.active?.webContents.isFocused()) this.window.webContents.focus();
    this.active?.setVisible(false);
    this.shield.setVisible(false);
    this.placement = null;
  }

  /**
   * @param human 原生后端已确认的控制者；true 时允许用户直接输入。
   * 控制者与页面忙闲分离，状态刷新不会撤销人工输入；不返回值或抛出业务异常。
   */
  setHuman(human: boolean): void {
    this.human = human;
    if (!human && this.active?.webContents.isFocused()) this.window.webContents.focus();
    this.shield.setVisible(!human && this.placement !== null);
  }

  /** @returns 已登记下载状态的独立副本，不暴露临时路径，不抛出业务异常。 */
  listDownloads(): BrowserDownload[] {
    return [...this.downloads.values()].map((item) => ({ ...item.view }));
  }

  /**
   * @param id 本对话已完成的下载身份；用户在窗口保存对话框中选择目标。
   * @returns 取消或写入完成后兑现；取消不写入，失败保留原下载供重试。
   * @throws 下载无效、窗口已关闭、系统选择器或文件复制失败时拒绝。
   */
  async saveDownload(id: string): Promise<void> {
    const download = this.downloads.get(id);
    if (!download || download.view.status !== "completed") throw new Error("下载尚未完成或已关闭");
    const chosen = await dialog.showSaveDialog(this.window, {
      defaultPath: download.view.name,
      properties: ["showOverwriteConfirmation"],
    });
    if (!chosen.canceled && chosen.filePath) {
      if (this.closed) throw new Error("浏览器已关闭");
      await copyFile(download.item.getSavePath(), chosen.filePath);
    }
  }

  /**
   * @returns 本对话网页与私有监听关闭后兑现；重复调用可安全完成。
   * @throws 原生资源或监听关闭失败时拒绝，不销毁应用主窗口。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.partition.off("will-download", this.download);
    this.partition.setPermissionRequestHandler(null);
    for (const download of this.downloads.values())
      if (download.view.status === "running") download.item.cancel();
    for (const view of this.views)
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    this.bridge.close();
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.shield);
    // 原生关闭是异步的；包括未登记页面，所有真实资源销毁后才交付关闭完成。
    const contents = [...this.views].map((view) => view.webContents);
    contents.push(this.anchor.webContents, this.shield.webContents);
    await Promise.all(
      contents.map((contents) => {
        if (contents.isDestroyed()) return;
        return new Promise<void>((resolve) => {
          contents.once("destroyed", resolve);
          contents.close({ waitForBeforeUnload: false });
        });
      }),
    );
    this.views.clear();
    this.websocket.close();
    // ready 的失败已交付资源创建方；没有开始监听时无需重复关闭一个不存在的监听器。
    if (
      await this.ready.then(
        () => true,
        () => false,
      )
    )
      await new Promise<void>((resolve, reject) =>
        this.http.close((error) => (error ? reject(error) : resolve())),
      );
  }

  private preferences(): Electron.WebPreferences {
    return {
      session: this.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 仅当前网页视图启用原生 WebMCP，不能向主应用或用户浏览器扩展权限。
      enableBlinkFeatures: "WebMCP",
      backgroundThrottling: false,
    };
  }

  private createView(
    preferences: Electron.WebPreferences = {},
    contents?: WebContents,
  ): WebContentsView {
    if (this.closed || this.window.isDestroyed()) throw new Error("浏览器窗口已关闭");
    const view = new WebContentsView({
      webPreferences: { ...preferences, ...this.preferences() },
      ...(contents ? { webContents: contents } : {}),
    });
    this.views.add(view);
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if ((!/^https?:/.test(url) && url !== "about:blank") || this.views.size >= 12)
        return { action: "deny" };
      return {
        action: "allow",
        createWindow: (options) => {
          // 原生 window.open 已创建的 WebContents 带着 opener 和导航，必须接入原对象。
          const supplied = "webContents" in options ? options.webContents : undefined;
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate === supplied);
          if (supplied && !contents) throw new Error("浏览器弹窗身份无效");
          const popup = this.createView(options.webPreferences, contents);
          // Electron 在 createWindow 返回后才接上 opener；登记前等待本次原生创建结算。
          void setImmediate()
            .then(() => this.bridge.adopt(popup))
            .then((target) => {
              if (this.placement) this.show(target, this.placement);
              this.changed();
            })
            .catch((error: unknown) => {
              if (!popup.webContents.isDestroyed()) popup.webContents.close();
              console.error("浏览器弹出页面接入失败", error);
            });
          return popup.webContents;
        },
      };
    });
    view.webContents.on("context-menu", (_event, params) => {
      if (!this.human) return;
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL)
        items.push(
          {
            label: "在新标签页打开链接",
            click: () => {
              void this.createPopup(params.linkURL).catch((error: unknown) =>
                console.error("浏览器链接打开失败", error),
              );
            },
          },
          { label: "复制链接地址", click: () => clipboard.writeText(params.linkURL) },
          { type: "separator" },
        );
      if (params.isEditable)
        items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
      else if (params.selectionText) items.push({ role: "copy" });
      items.push(
        { type: "separator" },
        { label: "重新加载", click: () => view.webContents.reload() },
      );
      Menu.buildFromTemplate(items).popup({ window: this.window });
    });
    view.webContents.once("destroyed", () => {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      this.views.delete(view);
      if (this.active === view) {
        this.active = null;
        this.placement = null;
        this.shield.setVisible(false);
      }
    });
    return view;
  }

  private async createPopup(url: string): Promise<void> {
    const target = await this.bridge.open(url);
    if (this.placement) this.show(target, this.placement);
    this.changed();
  }

  private bounds(value: Rectangle): Rectangle {
    const area = this.window.getContentBounds();
    const x = Math.max(0, Math.min(area.width, Math.round(value.x)));
    const y = Math.max(0, Math.min(area.height, Math.round(value.y)));
    return {
      x,
      y,
      width: Math.max(1, Math.min(area.width - x, Math.round(value.width))),
      height: Math.max(1, Math.min(area.height - y, Math.round(value.height))),
    };
  }

  private async browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // 逐页 debugger 的 Storage 默认指向应用默认分区，必须在宿主边界显式绑定本对话。
    if (method === "Storage.getCookies") {
      const cookies = await this.partition.cookies.get({});
      return {
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expirationDate ?? -1,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          session: cookie.session,
          sameSite:
            cookie.sameSite === "no_restriction"
              ? "None"
              : cookie.sameSite === "strict"
                ? "Strict"
                : "Lax",
        })),
      };
    }
    if (method === "Storage.clearCookies") {
      await this.partition.clearStorageData({ storages: ["cookies"] });
      return {};
    }
    if (method === "Storage.setCookies") {
      if (!Array.isArray(params["cookies"])) throw new Error("浏览器 Cookie 参数无效");
      const cookies = params["cookies"].map((value: unknown): Electron.CookiesSetDetails => {
        const cookie = record(value);
        const domain = text(cookie, "domain"),
          path = text(cookie, "path");
        const secure = cookie["secure"] === true;
        const url = new URL(`${secure ? "https" : "http"}://${domain.replace(/^\./, "")}${path}`);
        const expires = cookie["expires"];
        if (expires !== undefined && (typeof expires !== "number" || !Number.isFinite(expires)))
          throw new Error("浏览器 Cookie 期限无效");
        const sameSite = cookie["sameSite"];
        if (
          sameSite !== undefined &&
          sameSite !== "None" &&
          sameSite !== "Lax" &&
          sameSite !== "Strict"
        )
          throw new Error("浏览器 Cookie 同源策略无效");
        return {
          url: url.href,
          name: text(cookie, "name"),
          value: text(cookie, "value"),
          path,
          secure,
          httpOnly: cookie["httpOnly"] === true,
          sameSite:
            sameSite === "None" ? "no_restriction" : sameSite === "Strict" ? "strict" : "lax",
          ...(domain.startsWith(".") ? { domain } : {}),
          ...(typeof expires === "number" && expires >= 0 ? { expirationDate: expires } : {}),
        };
      });
      await Promise.all(cookies.map((cookie) => this.partition.cookies.set(cookie)));
      return {};
    }
    if (method.startsWith("Storage.")) throw new Error(`浏览器存储命令未开放：${method}`);
    if (method === "Browser.cancelDownload") {
      const download = this.downloads.get(text(params, "guid"));
      if (!download) throw new Error("下载不属于本会话");
      download.item.cancel();
    } else if (params["downloadPath"] !== this.downloadDirectory)
      throw new Error("不能替换宿主下载目录");
    return {};
  }

  private readonly download = (
    _event: Electron.Event,
    item: DownloadItem,
    contents: Electron.WebContents,
  ): void => {
    if (!this.downloadDirectory || ![...this.views].some((view) => view.webContents === contents)) {
      item.cancel();
      return;
    }
    const id = randomUUID();
    item.setSavePath(join(this.downloadDirectory, id));
    const download: Download = {
      item,
      view: { id, name: item.getFilename(), bytes: 0, status: "running", error: null },
    };
    this.downloads.set(id, download);
    const started = (async () => {
      const result: unknown = await contents.debugger.sendCommand("Page.getFrameTree");
      const frame = record(record(record(result)["frameTree"])["frame"]);
      this.bridge.event("Browser.downloadWillBegin", {
        guid: id,
        frameId: text(frame, "id"),
        url: item.getURL(),
        suggestedFilename: item.getFilename(),
      });
    })();
    void started.catch((error: unknown) => {
      item.cancel();
      download.view.error = String(error);
      this.changed();
    });
    item.on("updated", () => {
      download.view.bytes = item.getReceivedBytes();
      if (download.view.bytes > 33554432) item.cancel();
      void started.then(
        () =>
          this.bridge.event("Browser.downloadProgress", {
            guid: id,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            state: "inProgress",
          }),
        () => undefined,
      );
      this.changed();
    });
    item.once("done", (_event, state) => {
      download.view.status = state === "completed" ? "completed" : "failed";
      download.view.bytes = item.getReceivedBytes();
      if (state !== "completed") download.view.error = "下载已取消或中断";
      void started.then(
        () =>
          this.bridge.event("Browser.downloadProgress", {
            guid: id,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            state: state === "completed" ? "completed" : "canceled",
          }),
        () => undefined,
      );
      this.changed();
    });
  };
}
