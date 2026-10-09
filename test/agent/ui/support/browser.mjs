import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { ExtensionBrowser } from "../../../../modules/agent/web-runtime/dist/extension/browser.js";

const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");

// 测试只替换 chrome.debugger 的传输，DOM、输入与下载实际在 Chromium 中执行。
class Transport {
  sequence = 0;
  pending = new Map();
  root = null;
  event = () => {};
  constructor(socket, target) {
    this.socket = socket;
    this.target = target;
    socket.addEventListener("message", (message) => {
      const packet = JSON.parse(String(message.data));
      if (packet.id) {
        const request = this.pending.get(packet.id);
        if (!request) return;
        this.pending.delete(packet.id);
        if (packet.error) request.reject(new Error(packet.error.message));
        else request.resolve(packet.result);
      } else if (packet.sessionId) {
        this.event(
          { tabId: 1, ...(packet.sessionId === this.root ? {} : { sessionId: packet.sessionId }) },
          packet.method,
          packet.params || {},
        );
      }
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) request.reject(new Error("测试 CDP 已关闭"));
      this.pending.clear();
    });
  }
  command(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("测试 CDP 不再连接"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach() {
    const result = await this.command("Target.attachToTarget", {
      targetId: this.target,
      flatten: true,
    });
    this.root = result.sessionId;
  }
  async detach() {
    if (this.root) await this.command("Target.detachFromTarget", { sessionId: this.root });
    this.root = null;
  }
  send(session, method, values = {}) {
    return this.command(method, values, session.sessionId || this.root);
  }
}

/** 隔离配置目录与本机测试页面；测试退出后清理全部 Chromium、socket 和文件。 */
export async function fixture(t, html, respond) {
  const cleanups = [];
  const after = (cleanup) => cleanups.unshift(cleanup);
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
  });
  const root = await mkdtemp(join(tmpdir(), "noemori-extension-test-"));
  after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    if (respond?.(request, response)) return;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(root, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: ["--remote-debugging-port=0", "--site-per-process"],
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  after(() => context.close());
  const page = context.pages()[0];
  await page.goto(origin);
  const [port, endpoint] = (await readFile(join(root, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  after(() => socket.close());
  const transport = new Transport(socket, null);
  const targets = await transport.command("Target.getTargets");
  transport.target = targets.targetInfos.find(
    (target) => target.type === "page" && target.url === `${origin}/`,
  ).targetId;
  globalThis.chrome = {
    tabs: {
      async get() {
        return { id: 1, title: await page.title(), url: page.url() };
      },
      async remove() {
        await page.close();
      },
    },
  };
  const files = [];
  const bridge = {
    async artifact(value, signal) {
      if (signal.aborted) throw new Error("受管保存已取消");
      const bytes = Buffer.from(value.data, "base64");
      files.push({ ...value, bytes });
      return { bytes: bytes.length };
    },
  };
  const browser = new ExtensionBrowser(
    "test-session",
    "test-connection",
    transport,
    bridge,
    () => {},
  );
  after(() => browser.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  transport.event = (source, method, values) => {
    void browser.event(source, method, values).catch((error) => errors.push(error));
  };
  await browser.share(1);
  const id = "test-connection:1";
  const run = (action, signal = new AbortController().signal, timeout = 5000) =>
    browser.execute(action, signal, timeout);
  const observe = () => run({ action: "observe", page: id });
  return { page, context, transport, browser, run, observe, id, origin, files, errors };
}

/** 从明确的文字观察获得引用；缺失与歧义均不能由测试猜测节点编号。 */
export function ref(observation, name) {
  const matches = observation.elements.filter((entry) => entry.description.includes(name));
  if (matches.length !== 1)
    throw new Error(`控件 ${name} 不唯一：${JSON.stringify(observation.elements)}`);
  return { page: observation.page, observation: observation.id, ref: matches[0].ref };
}
