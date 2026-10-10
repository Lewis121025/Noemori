import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { createGateway } from "../network.js";
import { BrowserEngine } from "./engine.js";
import { record, type BrowserSettings } from "./contract.js";
import { reason } from "./observation.js";
import { limitDownloads } from "./download-limit.js";
import { BrowserProxyResolver } from "./proxy.js";
import { releaseBrowserResources } from "./lifecycle.js";
import { ControlOutput } from "../output.js";

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

const output = new ControlOutput(process.stdout);
const write = (value: unknown): Promise<void> => output.write(value);

async function main(): Promise<void> {
  console.log = (...values: unknown[]) => console.error(...values);
  let closing = false;
  let acknowledgeClose = false;
  const notifications = new Set<Promise<void>>();
  const notificationErrors: unknown[] = [];
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const taskErrors: unknown[] = [];
  const proxies = new BrowserProxyResolver(write);
  let releaseGateway: (() => Promise<void>) | undefined;
  let releaseBrowser: (() => Promise<void>) | undefined;
  let releaseContext: (() => Promise<void>) | undefined;
  let releaseDownloads: (() => Promise<void>) | undefined;
  const failures: unknown[] = [];
  // stdin EOF 同样撤销通知入口；正常关闭先停通知，再回收页面和 CDP 连接。
  process.stdin.once("end", () => { closing = true; });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const terminate = () => {
    closing = true;
    for (const controller of active.values()) controller.abort();
    lines.close();
    process.stdin.destroy();
  };
  output.signal.addEventListener("abort", terminate, { once: true });
  const publish = (value: unknown): void => {
    if (closing) return;
    const task = write(value).catch((error: unknown) => {
      notificationErrors.push(error);
      terminate();
    }).finally(() => notifications.delete(task));
    notifications.add(task);
  };
  const input = lines[Symbol.asyncIterator]();
  const next = async () => {
    const line = await input.next();
    if (output.error) throw output.error;
    if (line.done || Buffer.byteLength(line.value) > 1024 * 1024)
      throw new Error("浏览器控制输入已关闭或超限");
    return record(JSON.parse(line.value));
  };
  try {
    const config = await next();
    if (config.kind === "close") {
      closing = true;
      acknowledgeClose = true;
      return;
    }
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
    const gateway = await createGateway(
      undefined,
      integer(config.max_network_bytes, 2 ** 31 - 1),
      privateOrigins,
      (url) => proxies.resolve(url),
    );
    releaseGateway = () => gateway.close();
    await write({
      kind: "browser_start",
      executable:
        config.browser_path === null ? chromium.executablePath() : text(config.browser_path),
      proxy_url: gateway.url,
    });
    const ready = await next();
    if (ready.kind === "close") {
      closing = true;
      acknowledgeClose = true;
      return;
    }
    if (ready.kind !== "browser_ready") throw new Error("宿主未提供浏览器租约");
    const browser = await chromium.connectOverCDP(text(ready.endpoint), {
      artifactsDir: settings.download_directory,
      ...(ready.embedded === true ? { noDefaults: true, isLocal: true } : {}),
    });
    releaseBrowser = () => browser.close();
    browser.on("disconnected", () => {
      publish({ kind: "failed", error: "浏览器控制连接已断开，原有页面状态失效" });
    });
    const context = ready.embedded === true ? browser.contexts()[0] : await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: true,
      permissions: [],
    });
    if (!context) throw new Error("内嵌浏览器未提供独占网页会话");
    releaseContext = () => context.close();
    releaseDownloads = await limitDownloads(
      browser,
      context,
      settings.download_directory,
      settings.max_download_bytes,
      ready.embedded === true,
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
      (tabs, handoff) => {
        publish({ kind: "state", tabs, handoff });
      },
      ready.embedded === true,
      () => gateway.errors,
    );
    releaseContext = () => engine.close();
    await write({ kind: "ready" });
    for (;;) {
      const frame = await input.next();
      if (frame.done || output.error) break;
      // 控制帧还包含宿主标识和元数据；动作本身的 1 MiB 预算由输入契约可恢复地拒绝。
      if (Buffer.byteLength(frame.value) > 16 * 1024 * 1024)
        throw new Error("浏览器控制帧超过 16 MiB");
      const command = record(JSON.parse(frame.value));
      if (command.kind === "proxy_ready") {
        proxies.accept(command);
        continue;
      }
      if (command.kind === "close") { closing = true; acknowledgeClose = true; break; }
      const id = text(command.id);
      if (command.kind === "cancel") {
        active.get(id)?.abort();
        continue;
      }
      if (command.kind !== "execute" || active.size !== 0)
        throw new Error("浏览器命令必须串行执行");
      const timeout = integer(command.timeout_ms, 120000);
      const controller = new AbortController();
      active.set(id, controller);
      const task = engine
        .dispatch(command.action, controller.signal, timeout)
        .then(async (result) => {
          // 先撤销占用再写回复，宿主收到回复后才能派发下一命令。
          active.delete(id);
          await write({ kind: "result", id, result });
        })
        .catch((error: unknown) => {
          taskErrors.push(error);
          terminate();
        })
        .finally(() => tasks.delete(task));
      tasks.add(task);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    closing = true;
    proxies.close();
    for (const controller of active.values()) controller.abort();
    try {
      await releaseBrowserResources([
        // 内嵌默认上下文关闭会断开整个 CDP 连接，浏览器级下载订阅必须先释放。
        () => releaseDownloads?.(),
        () => releaseContext?.(),
        async () => {
          await Promise.all(tasks);
          if (taskErrors.length) throw new AggregateError(taskErrors, `浏览器执行结果未完成交付：${taskErrors.map(reason).join("；")}`);
        },
        async () => {
          await Promise.all(notifications);
          if (notificationErrors.length) throw new AggregateError(notificationErrors, "浏览器状态通知未完成交付");
        },
        () => releaseBrowser?.(),
        () => releaseGateway?.(),
        () => {
          lines.close();
          process.stdin.destroy();
        },
      ]);
    } catch (error) {
      failures.push(error);
    }
    if (output.error && !failures.includes(output.error)) failures.unshift(output.error);
    if (failures.length > 1)
      throw new AggregateError(failures, failures.map(reason).join("；"));
    if (failures.length) throw failures[0];
    if (acknowledgeClose) await write({ kind: "closed" });
  }
}

await main().catch(async (error: unknown) => {
  process.exitCode = 1;
  await output.reportFailure(error);
  process.stdin.destroy();
});
