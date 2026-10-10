import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { ManagedPageExtensions } from "../../../../modules/agent/web-runtime/dist/browser/managed-extensions.js";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = viteRequire("esbuild");

test("真实内嵌页面共用用户输入与 Agent 会话，标签导航和下载不依赖截图", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-embedded-e2e-"));
  let child, browser;
  const pending = new Map();
  let next = 0;
  try {
    const entry = join(directory, "window.cjs");
    await build({ entryPoints: [resolve("test/agent/browser/support/embedded-window.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    const env = { ...process.env, NOEMORI_EMBEDDED_PROFILE: join(directory, "profile") };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require("../../../../modules/notes/packages/desktop/node_modules/electron"), [entry], { env, stdio: ["pipe", "pipe", "inherit"] });
    let initialized;
    const ready = new Promise((done) => { initialized = done; });
    let proxyWaiting;
    const waiting = new Promise((done) => { proxyWaiting = done; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const result = JSON.parse(line);
      if (result.kind === "ready") initialized(result);
      else if (result.kind === "proxy_wait") proxyWaiting();
      else {
        const reply = pending.get(result.id); pending.delete(result.id);
        if (result.error) reply?.reject(new Error(result.error)); else reply?.resolve(result.result);
      }
    });
    const command = (value) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, ...value }) + "\n");
    });
    const { lease, appTarget } = await ready;
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proxy: "http://127.0.0.1:9", downloads: directory }) };
    const first = fetch(lease, request).then((response) => ({ response }), (error) => ({ error }));
    await waiting;
    const competing = await fetch(lease, request);
    assert.equal(competing.status, 403, "申请尚未完成时，第二个申请也不能替换租约");
    await command({ action: "releaseProxy" });
    const result = await first;
    if (result.error) throw result.error;
    const allocation = result.response;
    assert.equal(allocation.status, 200);
    const { endpoint } = await allocation.json();
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, artifactsDir: directory });
    const context = browser.contexts()[0];
    const cookies = await context.cookies();
    assert.equal(cookies.some((cookie) => cookie.name === "app-only"), false, "应用 Cookie 不能进入 Agent 浏览器");
    assert.equal(cookies.find((cookie) => cookie.name === "browser-only")?.value, "shared-login");
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // HTTPS 内容由本地路由提供；实际 Electron 网页视图启用原生 WebMCP，测试不访问外部网站。
    await context.route("https://webmcp.fixture.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>原生 WebMCP 验证</title><output></output>" }));
    await page.goto("https://webmcp.fixture.test/");
    await page.evaluate(async () => {
      if (!document.modelContext) throw new Error("内嵌网页没有启用真实 WebMCP");
      await document.modelContext.registerTool({ name: "update", description: "更新隔离测试结果", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async (input) => { document.querySelector("output").textContent = input.text; return JSON.stringify({ saved: input.text }); } });
    });
    const extensions = new ManagedPageExtensions(context, page);
    const extensionExecution = { signal: new AbortController().signal, check() {}, budget: () => 5000, dispatch() {} };
    const state = await extensions.execute({ action: "extension_state", page: "test-page" }, extensionExecution);
    assert.ok(state.capabilities.some((capability) => capability.name === "webmcp"));
    await extensions.execute({ action: "grant_capability", page: "test-page", ...state, capability: "webmcp" }, extensionExecution);
    const tools = await extensions.execute({ action: "webmcp_list", page: "test-page" }, extensionExecution);
    const prepared = await extensions.execute({ action: "webmcp_prepare", page: "test-page", directory: tools.directory, tool: tools.tools[0].id, input: { text: "Electron 原生工具" } }, extensionExecution);
    const invoked = await extensions.execute({ action: "webmcp_invoke", page: "test-page", prepared: prepared.prepared }, extensionExecution);
    assert.equal(invoked.result.value.saved, "Electron 原生工具");
    assert.equal(await page.locator("output").textContent(), "Electron 原生工具");
    await extensions.close();
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent('<title>交互页面</title><input id="name"><button id="save" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">保存</button><output></output>'));
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    const targets = await cdp.send("Target.getTargets");
    assert.equal(targets.targetInfos.some((target) => target.targetId === appTarget), false, "网页会话不能发现应用主界面");
    await assert.rejects(cdp.send("Target.attachToTarget", { targetId: appTarget, flatten: true }), /不属于本对话|未开放/);
    const pageCookies = await cdp.send("Storage.getCookies");
    assert.equal(pageCookies.cookies.some((cookie) => cookie.name === "app-only"), false, "逐页调试会话也只能读取本浏览器 Cookie");
    await cdp.detach();
    await command({ action: "show", target: targetInfo.targetId, placement: { page: "page", human: true, bounds: { x: 30, y: 90, width: 700, height: 500 } } });
    await page.locator("#name").fill("同一个页面");
    const button = await page.locator("#save").boundingBox();
    assert.ok(button);
    const point = { x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) };
    await command({ action: "input", target: targetInfo.targetId, events: [{ type: "mouseDown", ...point }, { type: "mouseUp", ...point }] });
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "同一个页面");
    await command({ action: "show", target: targetInfo.targetId, placement: { page: "page", human: false, bounds: { x: 30, y: 90, width: 700, height: 500 } } });
    await page.locator("#name").fill("助手继续操作");
    await page.getByRole("button", { name: "保存" }).click({ force: true });
    assert.equal(await page.locator("output").innerText(), "助手继续操作");
    await page.goto("data:text/html,<title>后续页面</title>");
    await page.goBack();
    assert.equal(await page.locator("#name").inputValue(), "助手继续操作");
    const second = await context.newPage();
    await second.goto("data:text/html,<title>第二标签页</title>");
    assert.equal(context.pages().length, 2);
    await second.close();
    const popupReady = page.waitForEvent("popup").then((popup) => ({ popup }), (error) => ({ error }));
    await page.evaluate(() => { const popup = window.open("about:blank"); if (!popup) throw new Error("弹出页面被错误阻止"); popup.document.title = "登录页面"; });
    const popupResult = await popupReady;
    if (popupResult.error) throw popupResult.error;
    const popup = popupResult.popup;
    assert.equal(await popup.evaluate(() => window.opener !== null), true, "登录弹窗必须保留 opener");
    await popup.close();
    const downloadReady = page.waitForEvent("download").then((download) => ({ download }), (error) => ({ error }));
    await page.evaluate(() => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["浏览器下载内容"], { type: "text/plain" })); link.download = "example.txt"; link.click(); });
    const downloadResult = await downloadReady;
    if (downloadResult.error) throw downloadResult.error;
    const download = downloadResult.download;
    assert.equal(await readFile(await download.path(), "utf8"), "浏览器下载内容");
    const downloads = await command({ action: "downloads" });
    assert.equal(downloads.find((download) => download.name === "example.txt")?.status, "completed");
    await assert.rejects(command({ action: "show", target: "other-conversation", placement: { page: "page", human: true, bounds: { x: 0, y: 0, width: 100, height: 100 } } }), /页面已关闭/);
    const count = await command({ action: "contents" });
    await command({ action: "failNextCreate" });
    await assert.rejects(context.newPage(), /页面初始化失败/);
    assert.equal(await command({ action: "contents" }), count, "初始化失败也必须立即回收未登记的真实网页");
    await browser.close(); browser = undefined;
    const stopped = once(child, "exit");
    assert.deepEqual(await command({ action: "close" }), { status: "closed", remaining: 0 });
    await stopped; child = undefined;
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    if (browser) await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
