import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onFlushResult, type CloseGate } from "../../../../../modules/notes/packages/desktop/src/main/close-gate";

const { call, shutdown, register, historyItems, windowOptions } = vi.hoisted(() => ({
  call: vi.fn(),
  shutdown: vi.fn(),
  register: vi.fn(),
  windowOptions: vi.fn(),
  historyItems: new Map([
    ["undo", { enabled: false }],
    ["redo", { enabled: false }],
  ]),
}));

vi.mock("node:worker_threads", () => ({ Worker: class {} }));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/core-client", () => ({
  CoreClient: class {
    call = call;
    shutdown = shutdown;
  },
}));
vi.mock("../../../../../modules/notes/packages/desktop/src/main/ipc", () => ({ registerIpc: register }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    static windows: Window[] = [];
    static getAllWindows() {
      return Window.windows;
    }
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
    });
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super();
      windowOptions(options);
      Window.windows.push(this);
    }
    loadFile = vi.fn();
    loadURL = vi.fn();
    maximize = vi.fn();
    isMaximized = () => false;
    getBounds = () => ({ x: 10, y: 20, width: 900, height: 700 });
  }
  return {
    BrowserWindow: Window,
    Menu: {
      buildFromTemplate: vi.fn(),
      setApplicationMenu: vi.fn(),
      getApplicationMenu: vi.fn(() => ({ getMenuItemById: (id: string) => historyItems.get(id) })),
    },
    app: Object.assign(new EventEmitter(), {
      whenReady: () => Promise.resolve(),
      getPath: () => "/state",
      quit: vi.fn(),
      setActivationPolicy: vi.fn(),
    }),
    dialog: { showErrorBox: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("__dirname", "/desktop/out/main");
  call.mockResolvedValue({ window: null, appearance: "system" });
});

afterEach(async () => {
  const { app, BrowserWindow } = await import("electron");
  app.removeAllListeners();
  BrowserWindow.getAllWindows().splice(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function start() {
  await import("../../../../../modules/notes/packages/desktop/src/main/index");
  const electron = await import("electron");
  await vi.waitFor(() => expect(electron.BrowserWindow.getAllWindows()).toHaveLength(1));
  return { ...electron, window: electron.BrowserWindow.getAllWindows()[0]! };
}

describe("main process worker lifetime", () => {
  it("后台测试从创建起隐藏窗口并保持渲染调度，普通启动仍显示窗口", async () => {
    vi.stubEnv("NOUS_TEST_WINDOW", "hidden");
    const { app } = await start();
    expect(windowOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({ backgroundThrottling: false }),
      }),
    );
    if (process.platform === "darwin")
      expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("普通启动保持前台窗口与后台节流", async () => {
    vi.stubEnv("NOUS_TEST_WINDOW", "");
    await start();
    expect(windowOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        show: true,
        webPreferences: expect.objectContaining({ backgroundThrottling: true }),
      }),
    );
  });
  it("隐藏测试恢复最大化会话时不调用会显示窗口的 maximize", async () => {
    vi.stubEnv("NOUS_TEST_WINDOW", "hidden");
    call.mockResolvedValue({
      window: { x: 0, y: 0, width: 900, height: 700, maximized: true },
      appearance: "system",
    });
    const { window } = await start();
    expect(window.maximize).not.toHaveBeenCalled();
  });
  it("页面重载、渲染进程退出及关闭窗口都会清除旧历史菜单状态", async () => {
    const { window } = await start();
    const enable = () => {
      for (const item of historyItems.values()) item.enabled = true;
    };
    const disabled = () => {
      expect([...historyItems.values()].every((item) => !item.enabled)).toBe(true);
    };
    enable();
    window.webContents.emit("did-start-navigation", {}, "file:///index.html", false, false);
    expect([...historyItems.values()].every((item) => item.enabled)).toBe(true);
    window.webContents.emit("did-start-navigation", {}, "file:///index.html#anchor", true, true);
    expect([...historyItems.values()].every((item) => item.enabled)).toBe(true);
    window.webContents.emit("did-start-navigation", {}, "file:///index.html", false, true);
    disabled();
    enable();
    window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    disabled();
    enable();
    window.emit("closed");
    disabled();
  });
  it("创建窗口前恢复应用外观", async () => {
    call.mockResolvedValue({ window: null, appearance: "dark" });
    const { nativeTheme } = await start();
    expect(nativeTheme.themeSource).toBe("dark");
  });
  it("就绪前声明库内媒体协议，内核就绪后才接管请求", async () => {
    const { protocol } = await start();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: "nous-vault" }),
    ]);
    expect(protocol.handle).toHaveBeenCalledWith("nous-vault", expect.any(Function));
  });
  it("flushes the editor before stopping and holds quit until the worker has exited", async () => {
    const stopped = deferred<void>();
    shutdown.mockReturnValue(stopped.promise);
    const { app, window } = await start();
    const before = { preventDefault: vi.fn() };
    app.emit("before-quit", before);
    expect(before.preventDefault).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith("app.flushBeforeClose");
    expect(shutdown).not.toHaveBeenCalled();

    const gate: CloseGate = register.mock.calls[0]![1];
    onFlushResult(gate, true);
    const closing = { preventDefault: vi.fn() };
    window.emit("close", closing);
    expect(closing.preventDefault).not.toHaveBeenCalled();
    expect(call).toHaveBeenLastCalledWith("sessionPatch", {
      window: { x: 10, y: 20, width: 900, height: 700, maximized: false },
    });
    window.emit("closed");
    const quit = { preventDefault: vi.fn() };
    app.emit("will-quit", quit);
    app.emit("will-quit", quit);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit.preventDefault).toHaveBeenCalledTimes(2);
    expect(app.quit).not.toHaveBeenCalled();
    stopped.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    const finalQuit = { preventDefault: vi.fn() };
    app.emit("will-quit", finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
  });

  it("does not create a window after quitting during asynchronous startup", async () => {
    const loading = deferred<{ window: null; appearance: "system" }>();
    const stopped = deferred<void>();
    call.mockReturnValue(loading.promise);
    shutdown.mockReturnValue(stopped.promise);
    await import("../../../../../modules/notes/packages/desktop/src/main/index");
    const { app, BrowserWindow } = await import("electron");
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("sessionLoad"));
    app.emit("will-quit", { preventDefault: vi.fn() });
    loading.resolve({ window: null, appearance: "system" });
    stopped.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
  });

  it("reports a failed worker shutdown and permits quitting the unusable process", async () => {
    const stopped = deferred<void>();
    shutdown.mockReturnValue(stopped.promise);
    const { app, window, dialog } = await start();
    window.emit("closed");
    app.emit("will-quit", { preventDefault: vi.fn() });
    stopped.reject(new Error("线程异常退出"));
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(dialog.showErrorBox).toHaveBeenCalledWith("内核未正常关闭", "线程异常退出");
  });
});
