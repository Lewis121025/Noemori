import {
  ipcMain,
  session,
  View,
  WebContentsView,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import {
  intersectPageRects,
  parseWebPageUpdate,
  webPageId,
  webPageUrl,
  type PageRect,
  type WebPageLayout,
  type WebPageState,
  type WebPageUpdate,
} from "../shared/webpage";
import { webPageProtection } from "./webpage-memory";

/** 每个原生网页实例只属于一个正文节点，父视图负责裁剪而非改变网页布局。 */
type PageView = {
  frame: View;
  view: WebContentsView;
  entryUrl: string;
  lastUrl: string;
  layout: WebPageLayout;
  error: string | null;
  lastUsed: number;
  inputProtected: boolean;
  hadInput: boolean;
  state: WebPageState | null;
};

// 可见网页之外保留最近四个普通网页，输入或活动媒体不占用这份可回收缓存。
const INACTIVE_PAGE_LIMIT = 4;

function scaledRect(rect: PageRect, zoom: number): Electron.Rectangle {
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  return {
    x,
    y,
    width: Math.max(1, Math.round((rect.x + rect.width) * zoom) - x),
    height: Math.max(1, Math.round((rect.y + rect.height) * zoom) - y),
  };
}

/**
 * 管理一个主窗口的隔离网页，布局、浏览状态和释放都在同一生命周期内。
 * @param window 可信应用窗口；网页视图不使用应用 preload。
 */
class WebPageViews {
  private readonly pages = new Map<string, PageView>();
  private usage = 0;
  private trimming: Promise<void> | null = null;
  private trimRequested = false;

  constructor(private readonly window: BrowserWindow) {
    const partition = session.fromPartition(`noemori-webpages-${window.id}`);
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.on("will-download", (event) => event.preventDefault());
    partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(https?:|data:|blob:|wss?:)/i.test(details.url) });
    });
    window.once("closed", () => this.clear());
    window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.clear();
    });
  }

  private publish(id: string, page: PageView): void {
    if (
      this.pages.get(id) !== page ||
      this.window.webContents.isDestroyed() ||
      page.view.webContents.isDestroyed()
    )
      return;
    const contents = page.view.webContents;
    let url = page.lastUrl;
    try {
      url = webPageUrl(contents.getURL());
    } catch {
      /* 故障页的浏览器内部地址不传播到正文。 */
    }
    const state: WebPageState = {
      id,
      url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      error: page.error,
      canBack: contents.navigationHistory.canGoBack(),
      canForward: contents.navigationHistory.canGoForward(),
      focused: contents.isFocused(),
    };
    const previous = page.state;
    if (
      previous &&
      previous.url === state.url &&
      previous.title === state.title &&
      previous.loading === state.loading &&
      previous.error === state.error &&
      previous.canBack === state.canBack &&
      previous.canForward === state.canForward &&
      previous.focused === state.focused
    )
      return;
    page.state = state;
    this.window.webContents.send("reader.webpage.changed", state);
  }

  private fail(id: string, page: PageView, message: string): void {
    page.error = message;
    page.frame.setVisible(false);
    this.publish(id, page);
  }

  private async load(id: string, page: PageView, url: string): Promise<void> {
    try {
      page.lastUrl = webPageUrl(url);
      await page.view.webContents.loadURL(page.lastUrl);
    } catch (error) {
      // 新导航或销毁会取消旧请求；取消不是当前页面的加载故障。
      if (error instanceof Error && "code" in error && error.code === "ERR_ABORTED") return;
      if (this.pages.get(id) === page && !page.view.webContents.isDestroyed())
        this.fail(
          id,
          page,
          `网页加载失败：${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }

  private create(layout: WebPageLayout): PageView {
    const frame = new View();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 非持久分区与应用会话隔离；网站没有笔记库协议或 preload 能力。
        partition: `noemori-webpages-${this.window.id}`,
      },
    });
    const page: PageView = {
      frame,
      view,
      entryUrl: layout.url,
      lastUrl: layout.url,
      layout,
      error: null,
      lastUsed: ++this.usage,
      inputProtected: false,
      hadInput: false,
      state: null,
    };
    this.pages.set(layout.id, page);
    try {
      frame.setVisible(false);
      frame.addChildView(view);
      this.window.contentView.addChildView(frame);
      this.bindNavigation(layout.id, page);
      this.bindState(layout.id, page);
      void this.load(layout.id, page, layout.url);
      return page;
    } catch (error) {
      // 分配后尚未完成挂载也属于本实例，回滚必须关闭网页进程。
      this.remove(layout.id);
      throw error;
    }
  }

  private bindNavigation(id: string, page: PageView): void {
    const contents = page.view.webContents;
    contents.on("will-frame-navigate", (event) => {
      try {
        webPageUrl(event.url);
      } catch {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event) => {
      try {
        webPageUrl(event.url);
      } catch {
        event.preventDefault();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      // 新窗口链接在当前网页区域打开，不能创建携带应用权限的子窗口。
      void this.load(id, page, url);
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (mainFrame) {
        if (!inPlace) {
          page.hadInput = false;
          page.inputProtected = false;
        }
        try {
          page.lastUrl = webPageUrl(url);
        } catch {
          /* 内部故障页面不覆盖可重试地址。 */
        }
      }
    });
  }

  private bindState(id: string, page: PageView): void {
    const contents = page.view.webContents;
    contents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const modifier = input.control || input.meta;
      // 原生按键信号覆盖 Shadow DOM 中不可直接检查的输入，只记录是否编辑过。
      if (
        input.isComposing ||
        (!modifier && input.key.length === 1) ||
        ["Backspace", "Delete"].includes(input.key) ||
        (modifier && ["v", "x", "z", "y"].includes(input.key.toLowerCase()))
      )
        page.hadInput = true;
    });
    contents.on("did-start-loading", () => {
      page.error = null;
      this.position(page);
      this.publish(id, page);
    });
    const publish = () => this.publish(id, page);
    contents.on("did-stop-loading", publish);
    contents.on("page-title-updated", publish);
    contents.on("did-navigate", publish);
    contents.on("did-navigate-in-page", publish);
    contents.on("focus", publish);
    contents.on("blur", publish);
    contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.fail(id, page, `网页加载失败：${description}`);
    });
    contents.on("render-process-gone", () => this.fail(id, page, "网页进程已退出，请重新加载"));
  }

  private position(page: PageView): void {
    const { bounds, clip } = page.layout;
    const size = this.window.getContentBounds();
    const zoom = this.window.webContents.getZoomFactor();
    const visible = bounds && clip && intersectPageRects(bounds, clip);
    const viewport =
      visible &&
      intersectPageRects(scaledRect(visible, zoom), {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      });
    if (!bounds || !viewport || page.error !== null) {
      page.frame.setVisible(false);
      return;
    }
    const full = scaledRect(bounds, zoom);
    const frameBounds = page.frame.getBounds();
    if (
      frameBounds.x !== viewport.x ||
      frameBounds.y !== viewport.y ||
      frameBounds.width !== viewport.width ||
      frameBounds.height !== viewport.height
    )
      page.frame.setBounds(viewport);
    const contentBounds = {
      x: full.x - viewport.x,
      y: full.y - viewport.y,
      width: full.width,
      height: full.height,
    };
    const previous = page.view.getBounds();
    if (
      previous.x !== contentBounds.x ||
      previous.y !== contentBounds.y ||
      previous.width !== contentBounds.width ||
      previous.height !== contentBounds.height
    )
      page.view.setBounds(contentBounds);
    if (!page.frame.getVisible()) page.frame.setVisible(true);
  }

  /** 应用增量布局；卸载必须明确传递身份，离屏隐藏不会误删除网页输入。 */
  sync(update: WebPageUpdate): void {
    for (const id of update.removed) this.remove(id);
    for (const layout of update.layouts) {
      let page = this.pages.get(layout.id);
      if (page && page.entryUrl !== layout.url) {
        this.remove(layout.id);
        page = undefined;
      }
      if (!page && layout.bounds && layout.clip) page = this.create(layout);
      if (page) {
        if (layout.bounds) {
          page.lastUsed = ++this.usage;
          page.inputProtected = false;
        }
        page.layout = layout;
        this.position(page);
      }
    }
    this.requestTrim();
  }

  private requestTrim(): void {
    this.trimRequested = true;
    if (this.trimming) return;
    // 回收检查涉及远程页面脚本，不能占用布局 IPC 的提交边界。
    this.trimming = (async () => {
      do {
        this.trimRequested = false;
        await this.trimInactive();
      } while (this.trimRequested && this.pages.size > 0);
    })()
      .catch((error: unknown) => {
        console.error("网页后台回收失败", error);
      })
      .finally(() => {
        this.trimming = null;
        if (this.trimRequested && this.pages.size > 0) this.requestTrim();
      });
  }

  private async trimInactive(): Promise<void> {
    const candidates = [...this.pages]
      .filter(([, page]) => page.layout.bounds === null && !page.inputProtected && !page.hadInput)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    let excess = candidates.length - INACTIVE_PAGE_LIMIT;
    for (const [id, page] of candidates) {
      if (excess <= 0) return;
      const protection = await webPageProtection(page.view.webContents);
      if (this.pages.get(id) !== page || page.layout.bounds !== null) continue;
      if (
        protection === "discard" &&
        !page.view.webContents.isFocused() &&
        !page.view.webContents.isCurrentlyAudible()
      )
        this.remove(id);
      else if (protection === "input" || protection === "unknown") page.inputProtected = true;
      excess--;
    }
  }

  /** 浏览历史属于网页自身；重新加载失败页面仍沿用该实例和原始入口。 */
  action(id: string, action: unknown): void {
    if (action !== "back" && action !== "forward" && action !== "reload")
      throw new Error("网页操作无效");
    const page = this.pages.get(id);
    if (!page) return;
    const contents = page.view.webContents;
    if (action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    if (action === "reload") void this.load(id, page, page.lastUrl);
  }

  private remove(id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    page.frame.setVisible(false);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(page.frame);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  private clear(): void {
    for (const id of this.pages.keys()) this.remove(id);
  }
}

/**
 * 注册实时网页 IPC；仅接受应用主框架，网页和其他窗口不能操控正文视图。
 * @param getWindow 当前可信主窗口。
 * @throws 重复注册、来源不可信或布局无效时拒绝请求。
 */
export function registerWebPageIpc(getWindow: () => BrowserWindow | null): void {
  const managers = new WeakMap<BrowserWindow, WebPageViews>();
  function manager(event: IpcMainInvokeEvent): WebPageViews {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      window.webContents.isLoadingMainFrame()
    )
      throw new Error("网页请求来源无效");
    let views = managers.get(window);
    if (!views) {
      views = new WebPageViews(window);
      managers.set(window, views);
    }
    return views;
  }
  ipcMain.handle("reader.webpage.sync", (event, value: unknown) => {
    const update = parseWebPageUpdate(value);
    return manager(event).sync(update);
  });
  ipcMain.handle("reader.webpage.action", (event, id: unknown, action: unknown) =>
    manager(event).action(webPageId(id), action),
  );
}
