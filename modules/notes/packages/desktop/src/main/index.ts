import { join } from "node:path";
import { BrowserWindow, app, dialog, nativeTheme, protocol, screen } from "electron";
import { createCloseGate, onCloseAttempt, resetCloseGate, type CloseGate } from "./close-gate";
import { CoreClient } from "./core-client";
import { registerIpc } from "./ipc";
import type { WindowSession } from "./session";
import { installApplicationMenu, updateHistoryMenu } from "./menu";
import { VAULT_MEDIA_SCHEME, createVaultMediaHandler } from "./vault-media";
import { AgentService } from "../features/agent/main/service";
import { registerAgentIpc } from "../features/agent/main/ipc";

// 特权协议必须在 ready 之前注册；stream 让 <audio>/<video> 可以按区间拖动进度。
protocol.registerSchemesAsPrivileged([
  {
    scheme: VAULT_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
const closeGate: CloseGate = createCloseGate();
let core: CoreClient | null = null;
let storedWindow: WindowSession | null = null;
let quitState: "running" | "stopping" | "stopped" = "running";
let agent: AgentService | null = null;
const closingAgents = new Set<Promise<void>>();

// 桌面测试显式启用后台窗口；创建前决定可见性，避免先弹出再隐藏而抢走用户焦点。
const hiddenTestWindow = process.env["NOEMORI_TEST_WINDOW"] === "hidden";
if (hiddenTestWindow && process.platform === "darwin") app.setActivationPolicy("accessory");

/**
 * 把记下的窗口放到当前仍存在的显示器上，避免外接屏拔掉后开到屏外。
 *
 * @param stored 上次关闭时的几何。
 */
function clampWindow(stored: WindowSession): Electron.Rectangle {
  const display = screen.getDisplayMatching({
    x: stored.x,
    y: stored.y,
    width: stored.width,
    height: stored.height,
  });
  const area = display.workArea;
  const width = Math.min(Math.max(Math.round(stored.width), 640), area.width);
  const height = Math.min(Math.max(Math.round(stored.height), 480), area.height);
  let x = Math.round(stored.x);
  let y = Math.round(stored.y);
  if (x + width < area.x || x > area.x + area.width) {
    x = area.x + Math.floor((area.width - width) / 2);
  }
  if (y + height < area.y || y > area.y + area.height) {
    y = area.y + Math.floor((area.height - height) / 2);
  }
  return { x, y, width, height };
}

function rendererCanFlush(win: BrowserWindow | null): boolean {
  return win !== null && !win.webContents.isDestroyed() && !win.webContents.isLoadingMainFrame();
}

function persistWindow(win: BrowserWindow, client: CoreClient): void {
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  storedWindow = { ...bounds, maximized };
  // 同步入队，退出时由 shutdown 等待写完；macOS 再开窗口直接使用内存中的几何。
  void client.call("sessionPatch", { window: storedWindow }).catch((error: unknown) => {
    console.error("保存窗口状态失败", error);
  });
}

/**
 * 创建主窗口。
 *
 * 渲染进程无 Node、无直接磁盘访问；仅通过 preload 暴露的 IPC 与内核通信。
 */
function createWindow(client: CoreClient): void {
  const stored = storedWindow;
  const bounds = stored === null ? null : clampWindow(stored);
  mainWindow = new BrowserWindow({
    ...(bounds ?? { width: 1100, height: 720 }),
    minWidth: 640,
    minHeight: 480,
    show: !hiddenTestWindow,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202022" : "#ffffff",
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : {}),
    webPreferences: {
      // 沙箱 preload 必须是 CJS；electron-vite 在 format: "cjs" 时产出 index.cjs。
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏测试仍需执行动画帧和布局；正常应用保留 Electron 的节流行为。
      backgroundThrottling: !hiddenTestWindow,
    },
  });
  // Electron 的 maximize 会同时显示隐藏窗口；后台测试只恢复普通几何。
  if (!hiddenTestWindow && stored !== null && stored.maximized) {
    mainWindow.maximize();
  }

  mainWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
      updateHistoryMenu();
      agent?.detach();
    }
  });
  mainWindow.webContents.on("render-process-gone", () => {
    updateHistoryMenu();
    agent?.detach();
  });
  const owner = mainWindow;
  const service = new AgentService(
    join(app.getPath("userData"), "agent"),
    join(
      __dirname,
      "agent",
      process.platform === "win32" ? "noemori-terminal-sandbox.exe" : "noemori-terminal-sandbox",
    ),
    (id) => {
      if (mainWindow === owner && !owner.webContents.isDestroyed())
        owner.webContents.send("agent.changed", id);
    },
  );
  agent = service;

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  resetCloseGate(closeGate);
  mainWindow.on("close", (event) => {
    if (mainWindow !== null) {
      persistWindow(mainWindow, client);
    }
    const action = onCloseAttempt(closeGate, {
      asQuit: false,
      rendererReady: rendererCanFlush(mainWindow),
    });
    if (action === "proceed") {
      return;
    }
    event.preventDefault();
    if (action === "prevent-and-send") {
      mainWindow?.webContents.send("app.flushBeforeClose");
    }
  });
  mainWindow.on("closed", () => {
    if (agent === service) agent = null;
    const closing = service.shutdown();
    closingAgents.add(closing);
    void closing.then(
      () => closingAgents.delete(closing),
      (error: unknown) => {
        closingAgents.delete(closing);
        console.error("Agent 会话关闭失败", error);
      },
    );
    mainWindow = null;
    updateHistoryMenu();
  });
}

app.whenReady().then(async () => {
  const client = new CoreClient(app.getPath("userData"), (event) => {
    if (mainWindow !== null && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("reader.vault.changed", event);
    }
  });
  core = client;
  registerIpc(() => mainWindow, closeGate, client);
  registerAgentIpc(
    () => mainWindow,
    () => agent,
  );
  // 库根边界由内核 entryPath 校验；协议层只额外限制为音视频类型。
  protocol.handle(
    VAULT_MEDIA_SCHEME,
    createVaultMediaHandler((rel) => client.call("entryPath", rel)),
  );
  try {
    const session = await client.call("sessionLoad");
    storedWindow = session.window;
    nativeTheme.themeSource = session.appearance;
  } catch (error) {
    console.error("恢复窗口状态失败", error);
  }
  if (quitState !== "running") return;
  installApplicationMenu((command) => {
    if (rendererCanFlush(mainWindow)) mainWindow?.webContents.send("app.command", command);
  });
  createWindow(client);
  app.on("activate", () => {
    if (quitState === "running" && BrowserWindow.getAllWindows().length === 0) {
      createWindow(client);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  const action = onCloseAttempt(closeGate, {
    asQuit: true,
    rendererReady: rendererCanFlush(mainWindow),
  });
  if (action === "proceed") {
    return;
  }
  event.preventDefault();
  if (action === "prevent-and-send") {
    mainWindow?.webContents.send("app.flushBeforeClose");
  }
});

app.on("will-quit", (event) => {
  if (core === null || quitState === "stopped") return;
  event.preventDefault();
  if (quitState === "stopping") return;
  quitState = "stopping";
  void Promise.all([core.shutdown(), agent?.shutdown(), ...closingAgents])
    .catch((error: unknown) => {
      dialog.showErrorBox("内核未正常关闭", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      quitState = "stopped";
      app.quit();
    });
});
