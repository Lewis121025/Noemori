import { beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, WebContentsView } from "electron";
import { registerWebPageIpc } from "@reader/main/webpage-ipc";
import type { WebPageLayout } from "@reader/shared/webpage";

const port = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  load: vi.fn(async (_url: string) => {}),
  close: vi.fn(),
  send: vi.fn(),
  preferences: vi.fn(),
  requestPermission: vi.fn(),
  checkPermission: vi.fn(),
  requestFilter: vi.fn(),
  attach: vi.fn(),
  protection: vi.fn(async () => "discard"),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class View {
    children: View[] = [];
    visible = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    addChildView(view: View) {
      port.attach();
      this.children.push(view);
    }
    removeChildView(view: View) {
      this.children = this.children.filter((child) => child !== view);
    }
    setVisible(value: boolean) {
      this.visible = value;
    }
    getVisible() {
      return this.visible;
    }
    setBounds(value: typeof this.bounds) {
      this.bounds = value;
    }
    getBounds() {
      return this.bounds;
    }
  }
  class Contents extends EventEmitter {
    mainFrame = { framesInSubtree: [{ executeJavaScript: () => port.protection() }] };
    dead = false;
    url = "";
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    send = port.send;
    isDestroyed() {
      return this.dead;
    }
    isLoadingMainFrame() {
      return false;
    }
    getZoomFactor() {
      return 1;
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return "测试网页";
    }
    isLoading() {
      return false;
    }
    isFocused() {
      return false;
    }
    isCurrentlyAudible() {
      return false;
    }
    executeJavaScript() {
      return port.protection();
    }
    setWindowOpenHandler() {}
    async loadURL(url: string) {
      this.url = url;
      await port.load(url);
    }
    close() {
      this.dead = true;
      port.close();
    }
  }
  class WebContentsView extends View {
    webContents = new Contents();
    constructor(options: unknown) {
      super();
      port.preferences(options);
    }
  }
  class BrowserWindow extends EventEmitter {
    id = 1;
    contentView = new View();
    webContents = new Contents();
    getContentBounds() {
      return { x: 0, y: 0, width: 1000, height: 700 };
    }
    isDestroyed() {
      return false;
    }
  }
  return {
    View,
    WebContentsView,
    BrowserWindow,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        port.handlers.set(channel, handler),
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: port.requestPermission,
        setPermissionCheckHandler: port.checkPermission,
        on: () => {},
        webRequest: { onBeforeRequest: port.requestFilter },
      }),
    },
  };
});

const id = "12345678-1234-1234-1234-123456789abc";
const bounds = { x: 200, y: -80, width: 640, height: 480 };
const clip = { x: 200, y: 60, width: 640, height: 340 };
const layout = { id, url: "https://example.com/", bounds, clip };
let window: BrowserWindow;
beforeEach(() => {
  port.handlers.clear();
  vi.clearAllMocks();
  port.load.mockResolvedValue();
  port.protection.mockResolvedValue("discard");
  port.attach.mockReset();
  window = new BrowserWindow();
  registerWebPageIpc(() => window);
});
const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const sync = (layouts: unknown, sender: unknown = event()) =>
  port.handlers.get("reader.webpage.sync")!(sender, {
    layouts,
    removed: Array.isArray(layouts) && layouts.length === 0 ? [id] : [],
  });

it("原生视图挂载失败时回滚已分配网页，不能遗留浏览进程", async () => {
  port.attach
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error("窗口已关闭");
    });
  expect(() => sync([layout])).toThrow("窗口已关闭");
  expect(port.close).toHaveBeenCalledOnce();
  expect(window.contentView.children).toHaveLength(0);
});

it("只有主窗口主框架能创建或操作网页，非法来源不能初始化浏览分区", () => {
  for (const sender of [
    { ...event(), sender: {} },
    { ...event(), senderFrame: {} },
  ])
    expect(() => sync([layout], sender)).toThrow("来源无效");
  expect(port.preferences).not.toHaveBeenCalled();
  expect(port.requestPermission).not.toHaveBeenCalled();
  expect(() =>
    port.handlers.get("reader.webpage.action")!({ ...event(), sender: {} }, id, "reload"),
  ).toThrow("来源无效");
});

it("离屏不加载，可见区域只裁剪且保持网页完整大小，隐藏与卸载区分处理", () => {
  sync([{ ...layout, bounds: null, clip: null }]);
  expect(port.preferences).not.toHaveBeenCalled();
  sync([layout]);
  expect(port.preferences).toHaveBeenCalledWith({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "noemori-webpages-1",
    },
  });
  const frame = window.contentView.children[0];
  expect(frame?.getBounds()).toEqual(clip);
  expect(frame?.children[0]?.getBounds()).toEqual({ x: 0, y: -140, width: 640, height: 480 });
  expect(frame?.getVisible()).toBe(true);
  sync([{ ...layout, bounds: null, clip: null }]);
  expect(frame?.getVisible()).toBe(false);
  expect(port.close).not.toHaveBeenCalled();
  sync([]);
  expect(port.close).toHaveBeenCalledOnce();
  expect(window.contentView.children).toHaveLength(0);
});

it("失败页面不会因布局更新被重新显示，重新加载后可恢复", async () => {
  port.load.mockRejectedValueOnce(new Error("离线"));
  sync([layout]);
  await vi.waitFor(() =>
    expect(port.send).toHaveBeenLastCalledWith(
      "reader.webpage.changed",
      expect.objectContaining({ error: "网页加载失败：离线" }),
    ),
  );
  const frame = window.contentView.children[0];
  sync([layout]);
  expect(frame?.getVisible()).toBe(false);
  port.handlers.get("reader.webpage.action")!(event(), id, "reload");
  expect(port.load).toHaveBeenCalledTimes(2);
  sync([]);
});

it("文档重载和窗口关闭销毁网页，取消旧请求不误报为新页面故障", async () => {
  port.load.mockRejectedValueOnce(Object.assign(new Error("取消"), { code: "ERR_ABORTED" }));
  sync([layout]);
  await Promise.resolve();
  await Promise.resolve();
  expect(port.send).not.toHaveBeenCalled();
  window.webContents.emit("did-start-navigation", {}, "file:///app", false, true);
  expect(port.close).toHaveBeenCalledOnce();
  sync([layout]);
  window.emit("closed");
  expect(port.close).toHaveBeenCalledTimes(2);
});

it.each(["DOM 输入", "原生按键"])(
  "逐个浏览二十个网页后，普通离屏网页最多保留四个，%s受保护",
  async (kind) => {
    if (kind === "DOM 输入") port.protection.mockResolvedValueOnce("input");
    let previous: string | undefined;
    let first: (typeof window.contentView.children)[number] | undefined;
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      const pageId = `12345678-1234-1234-1234-${index.toString(16).padStart(12, "0")}`;
      ids.push(pageId);
      const layouts: WebPageLayout[] = [{ ...layout, id: pageId }];
      if (previous) layouts.push({ ...layout, id: previous, bounds: null, clip: null });
      await port.handlers.get("reader.webpage.sync")!(event(), { layouts, removed: [] });
      if (index === 0) {
        first = window.contentView.children[0];
        if (kind === "原生按键") {
          const view = first?.children[0];
          if (!(view instanceof WebContentsView)) throw new Error("缺少网页视图");
          view.webContents.emit(
            "before-input-event",
            {},
            { type: "keyDown", key: "字", meta: false, control: false, isComposing: false },
          );
          await port.handlers.get("reader.webpage.sync")!(event(), {
            layouts: [{ ...layout, id: pageId }],
            removed: [],
          });
        }
      }
      previous = pageId;
    }
    await vi.waitFor(() => expect(window.contentView.children).toHaveLength(6));
    expect(window.contentView.children).toContain(first);
    await port.handlers.get("reader.webpage.sync")!(event(), { layouts: [], removed: ids });
    expect(window.contentView.children).toHaveLength(0);
    expect(port.close).toHaveBeenCalledTimes(20);
  },
);

it("浏览事件状态不变时只发布一次，卸载后的迟到事件不能重新发布", async () => {
  await sync([layout]);
  const view = window.contentView.children[0]?.children[0];
  if (!(view instanceof WebContentsView)) throw new Error("缺少网页视图");
  view.webContents.emit("page-title-updated");
  view.webContents.emit("did-navigate");
  view.webContents.emit("did-stop-loading");
  expect(port.send).toHaveBeenCalledOnce();
  await sync([]);
  view.webContents.emit("page-title-updated");
  expect(port.send).toHaveBeenCalledOnce();
});

it("回收检查未返回时，布局提交仍能完成，不能阻塞下一帧", async () => {
  let release: ((value: string) => void) | undefined;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  port.protection.mockReturnValueOnce(pending);
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const pageId = `12345678-1234-1234-1234-${index.toString(16).padStart(12, "0")}`;
    ids.push(pageId);
    await port.handlers.get("reader.webpage.sync")!(event(), {
      layouts: [{ ...layout, id: pageId }],
      removed: [],
    });
  }
  let completed = false;
  const submitting = Promise.resolve(
    port.handlers.get("reader.webpage.sync")!(event(), {
      layouts: ids.map((id) => ({ ...layout, id, bounds: null, clip: null })),
      removed: [],
    }),
  ).then(() => {
    completed = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(true);
  } finally {
    release?.("discard");
    await submitting;
    await port.handlers.get("reader.webpage.sync")!(event(), { layouts: [], removed: ids });
  }
});
