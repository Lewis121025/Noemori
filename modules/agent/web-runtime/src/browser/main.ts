import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { createGateway } from "../network.js";
import { BrowserEngine } from "./engine.js";
import { record, type BrowserSettings } from "./contract.js";
import { reason } from "./observation.js";
import { limitDownloads } from "./download-limit.js";
import { BrowserProxyResolver } from "./proxy.js";
import { releaseBrowserResources } from "./lifecycle.js";

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("浏览器控制字段不是有效文本");
  return value;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error("浏览器控制字段超过整数范围");
  return value;
}

async function write(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

async function main(): Promise<void> {
  console.log = (...values: unknown[]) => console.error(...values);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const input = lines[Symbol.asyncIterator]();
  const next = async () => {
    const line = await input.next();
    if (line.done || Buffer.byteLength(line.value) > 1024 * 1024)
      throw new Error("浏览器控制输入已关闭或超限");
    return record(JSON.parse(line.value));
  };
  const config = await next();
  const settings: BrowserSettings = {
    workspace: text(config.workspace),
    download_directory: text(config.download_directory),
    max_pages: integer(config.max_pages, 32),
    max_chars: integer(config.max_chars, 100000),
    max_elements: integer(config.max_elements, 1000),
    max_download_bytes: integer(config.max_download_bytes, 64 * 1024 * 1024),
  };
  const origins = config.private_origins;
  if (!Array.isArray(origins)) throw new Error("缺少宿主网络来源配置");
  const privateOrigins = origins.map((value: unknown) => text(value));
  const proxies = new BrowserProxyResolver(write);
  const gateway = await createGateway(
    undefined,
    integer(config.max_network_bytes, 2 ** 31 - 1),
    privateOrigins,
    (url) => proxies.resolve(url),
  );
  await write({
    kind: "browser_start",
    executable:
      config.browser_path === null ? chromium.executablePath() : text(config.browser_path),
    proxy_url: gateway.url,
  });
  const ready = await next();
  if (ready.kind !== "browser_ready") throw new Error("宿主未提供浏览器租约");
  const browser = await chromium.connectOverCDP(text(ready.endpoint), {
    artifactsDir: settings.download_directory,
  });
  browser.on("disconnected", () => {
    void write({ kind: "failed", error: "浏览器控制连接已断开，原有页面状态失效" });
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: true,
    permissions: [],
  });
  const releaseDownloads = await limitDownloads(
    browser,
    context,
    settings.download_directory,
    settings.max_download_bytes,
  );
  await context.route("**/*", (route) =>
    /^(https?:|data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort(),
  );
  const engine = new BrowserEngine(
    context,
    settings,
    (origin) => {
      if (!privateOrigins.includes(origin)) privateOrigins.push(origin);
    },
    (tabs) => {
      void write({ kind: "state", tabs });
    },
  );
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  await write({ kind: "ready" });
  try {
    for (;;) {
      const frame = await input.next();
      if (frame.done) break;
      // 控制帧还包含宿主标识和元数据；动作本身的 1 MiB 预算由输入契约可恢复地拒绝。
      if (Buffer.byteLength(frame.value) > 16 * 1024 * 1024)
        throw new Error("浏览器控制帧超过 16 MiB");
      const command = record(JSON.parse(frame.value));
      if (command.kind === "proxy_ready") {
        proxies.accept(command);
        continue;
      }
      if (command.kind === "close") break;
      const id = text(command.id);
      if (command.kind === "cancel") {
        active.get(id)?.abort();
        continue;
      }
      if (command.kind !== "execute" || active.size !== 0)
        throw new Error("浏览器命令必须串行执行");
      const timeout = integer(command.timeout_ms, 120000);
      const controller = new AbortController();
      const previousErrors = new Set(gateway.errors);
      active.set(id, controller);
      const task = engine
        .dispatch(command.action, controller.signal, timeout)
        .then(async (result) => {
          const errors = [...gateway.errors]
            .filter((error) => !previousErrors.has(error))
            .slice(-3);
          if (result.error && errors.length) result.error += `；网络出口：${errors.join("；")}`;
          if (result.observation) result.observation.warnings.push(...errors);
          // 先撤销占用再写回复，宿主收到回复后才能派发下一命令。
          active.delete(id);
          await write({ kind: "result", id, result });
        })
        .finally(() => tasks.delete(task));
      tasks.add(task);
    }
  } finally {
    proxies.close();
    for (const controller of active.values()) controller.abort();
    await releaseBrowserResources([
      () => engine.close(),
      async () => {
        await Promise.all(tasks);
      },
      releaseDownloads,
      () => browser.close(),
      () => gateway.close(),
      () => {
        lines.close();
        process.stdin.destroy();
      },
    ]);
  }
}

await main().catch(async (error: unknown) => {
  await write({ kind: "failed", error: reason(error) });
  process.exitCode = 1;
  process.stdin.destroy();
});
