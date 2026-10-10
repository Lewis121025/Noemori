import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { expect, test } from "vitest";
import { closeTestProcess } from "../support/process-cleanup";

const desktop = fileURLToPath(
  new URL("../../../../modules/notes/packages/desktop/", import.meta.url),
);

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法分配调试端口");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

test("开发进程更新 preload 与主进程后，页面加载完整几何修复接口并调用新 IPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-development-reload-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "src/main/index.ts");
  const preload = join(root, "src/preload/index.ts");
  const renderer = join(root, "src/renderer");
  await Promise.all(
    ["src/main", "src/preload", "src/renderer"].map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );
  const packageJson: unknown = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("scripts" in packageJson) ||
    typeof packageJson.scripts !== "object" ||
    packageJson.scripts === null ||
    !("dev" in packageJson.scripts) ||
    typeof packageJson.scripts.dev !== "string"
  )
    throw new Error("缺少开发启动命令");
  const invocation = packageJson.scripts.dev.split("&&").at(-1)!.trim().split(/\s+/);
  if (invocation.shift() !== "electron-vite") throw new Error("开发启动入口已改变，需要更新旅程");

  const mainSource = (offset: number) => `
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(() => {
  ipcMain.handle("reader.whiteboard.repair", (_event, request) => ({ label: "line", points: request.points.map(point => ({...point, x: point.x + ${offset}})) }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, "../preload/index.cjs"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } });
  void window.loadURL(process.env.ELECTRON_RENDERER_URL!);
});
app.on("window-all-closed", () => app.quit());
`;
  const preloadSource = (complete: boolean) => `
import { contextBridge } from "electron";
import { createReaderApi } from ${JSON.stringify(join(desktop, "src/features/reader/preload/api.ts"))};
${complete ? "const reader = createReaderApi();" : "const { whiteboardRepair, ...reader } = createReaderApi();"}
contextBridge.exposeInMainWorld("noemori", { reader });
`;
  // 独立应用只提供几何修复 IPC；桥接直接使用生产实现，测试不改动工作区源码。
  await Promise.all([
    symlink(join(desktop, "node_modules"), join(root, "node_modules"), "junction"),
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "noemori-development-reload",
        type: "module",
        main: "out/main/index.js",
      }),
    ),
    writeFile(
      join(root, "electron.vite.config.mjs"),
      'export default { main: {}, preload: { build: { rollupOptions: { output: { format: "cjs" } } } }, renderer: {} };',
    ),
    writeFile(main, mainSource(0)),
    writeFile(preload, preloadSource(false)),
    writeFile(
      join(renderer, "index.html"),
      '<!doctype html><html><body><p id="bridge"></p><script type="module" src="/index.ts"></script></body></html>',
    ),
    writeFile(
      join(renderer, "index.ts"),
      'document.getElementById("bridge")!.textContent = typeof window.noemori.reader.whiteboardRepair;',
    ),
  ]);
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("ELECTRON_"),
    ),
  );
  const child = spawn(
    process.execPath,
    [
      join(desktop, "node_modules/electron-vite/bin/electron-vite.js"),
      ...invocation,
      "--remoteDebuggingPort",
      String(port),
      "--noSandbox",
      "--",
      `--user-data-dir=${join(root, "state")}`,
    ],
    { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-8000);
  });
  child.stderr?.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-8000);
  });
  let browser: Browser | undefined;
  const connect = async () => {
    await expect
      .poll(async () => (await fetch(`${endpoint}/json/version`)).ok, { timeout: 10000 })
      .toBe(true);
    browser = await chromium.connectOverCDP(endpoint);
    await expect
      .poll(() => browser?.contexts().flatMap((context) => context.pages()).length)
      .toBe(1);
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.locator("#bridge").waitFor();
    return page;
  };
  const points = [
    { x: 10, y: 20, pressure: 0.5 },
    { x: 100, y: 20, pressure: 0.5 },
  ];
  try {
    let page = await connect();
    expect(await page.locator("#bridge").textContent()).toBe("undefined");
    await writeFile(preload, preloadSource(true));
    await expect
      .poll(() => page.locator("#bridge").textContent(), { timeout: 10000 })
      .toBe("function");
    expect(
      await page.evaluate((value) => window.noemori.reader.whiteboardRepair(value), {
        points,
        observations: points,
        scale: 1,
      }),
    ).toEqual({ label: "line", points });

    await writeFile(main, mainSource(10));
    await expect.poll(() => browser?.isConnected(), { timeout: 10000 }).toBe(false);
    page = await connect();
    expect(
      await page.evaluate((value) => window.noemori.reader.whiteboardRepair(value), {
        points,
        observations: points,
        scale: 1,
      }),
    ).toEqual({ label: "line", points: points.map((point) => ({ ...point, x: point.x + 10 })) });
  } catch (cause) {
    throw new Error(`开发更新旅程失败：\n${output}`, { cause });
  } finally {
    if (browser?.isConnected()) await browser.close();
    await closeTestProcess(child, async () => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    });
  }
});
