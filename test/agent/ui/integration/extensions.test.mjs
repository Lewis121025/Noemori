import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, ref } from "../support/browser.mjs";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";

async function grant(f, capability) {
  const state = await f.run({ action: "extension_state", page: f.id });
  assert.equal(state.outcome, "observed", state.error);
  const result = await f.run({ action: "grant_capability", page: f.id, ...state.extensions, capability });
  assert.equal(result.outcome, "observed", result.error);
}

async function managed(t) {
  const real = await fixture(t, '<title>扩展验证</title><button onclick="document.body.dataset.clicked=1">目标</button>', undefined, { args: ["--enable-blink-features=WebMCP"] });
  const directory = await mkdtemp(join(tmpdir(), "noemori-managed-extensions-"));
  const engine = new BrowserEngine(real.context, { workspace: directory, download_directory: directory, max_pages: 8, max_chars: 12000, max_elements: 100, max_download_bytes: 1048576 });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const id = engine.tabs()[0].id;
  return { ...real, id, run: (action, signal = new AbortController().signal, timeout = 5000) => engine.execute(action, signal, timeout) };
}

test("真实Chrome未启用WebMCP时不广告，页面自造同名API也不能冒充", async (t) => {
  const f = await fixture(t, "<h1>未启用实验功能</h1>");
  await f.page.evaluate(() => { document.modelContext = { registerTool() {} }; window.ModelContext = function ModelContext() {}; });
  const result = await f.run({ action: "capabilities_list", page: f.id });
  assert.equal(result.outcome, "observed", result.error);
  assert.equal(result.extensions.capabilities.some((item) => item.name === "webmcp"), false);
  assert.equal(result.extensions.capabilities.some((item) => item.name === "developer_logs"), true);
});

test("真实扩展日志与CDP只读诊断独立授权，读取保持原DOM观察，导航撤销批准", async (t) => {
  const f = await fixture(t, '<button onclick="document.body.dataset.clicked=1">目标</button>');
  const observed = await f.observe();
  await f.run({ action: "capabilities_list", page: f.id });
  assert.equal((await f.run({ action: "developer_logs", page: f.id })).outcome, "not_executed");
  await grant(f, "developer_logs");
  await f.page.evaluate(() => console.log("真实开发日志", { nested: "不会执行getter" }));
  // 两条真实 CDP 连接的事件异步交付；同一 debugger session 的响应建立可观测事件屏障。
  await f.transport.send({ tabId: 1 }, "Runtime.evaluate", { expression: "void 0" });
  const logs = await f.run({ action: "developer_logs", page: f.id, after: 0, limit: 100 });
  assert.equal(logs.outcome, "observed", logs.error);
  assert.equal(logs.extensions.logs.entries.some((entry) => entry.text.includes("真实开发日志")), true);
  assert.equal(logs.extensions.untrusted, true);
  assert.equal((await f.run({ action: "cdp_send", page: f.id, method: "Page.getLayoutMetrics", params: {} })).outcome, "not_executed");
  await grant(f, "cdp");
  const metrics = await f.run({ action: "cdp_send", page: f.id, method: "Page.getLayoutMetrics", params: {} });
  assert.equal(metrics.outcome, "observed", metrics.error);
  assert.ok(metrics.extensions.result.value.cssLayoutViewport.clientWidth > 0);
  assert.equal((await f.run({ action: "cdp_send", page: f.id, method: "Runtime.evaluate", params: { expression: "document.body.dataset.bad=1" } })).outcome, "not_executed");
  const clicked = await f.run({ action: "click", ...ref(observed.observation, "目标") });
  assert.equal(clicked.outcome, "executed", clicked.error);
  assert.equal(await f.page.locator("body").getAttribute("data-bad"), null);
  await f.page.goto(f.origin + "/next");
  assert.equal((await f.run({ action: "developer_logs", page: f.id })).outcome, "not_executed");
  await grant(f, "developer_logs");
  assert.equal((await f.run({ action: "handoff" })).outcome, "executed");
  assert.equal((await f.run({ action: "developer_logs", page: f.id })).outcome, "not_executed");
  assert.equal((await f.run({ action: "resume" })).outcome, "executed");
  assert.equal((await f.run({ action: "developer_logs", page: f.id })).outcome, "not_executed");
});

for (const backend of ["managed", "extension"]) {
  test(`真实${backend}原生WebMCP注册、目录、调用和取消遵循标准CDP`, async (t) => {
    const f = backend === "managed" ? await managed(t) : await fixture(t, '<button>目标</button>', undefined, { args: ["--enable-blink-features=WebMCP"] });
    await f.page.evaluate(async () => {
      await document.modelContext.registerTool({ name: "update", description: "更新隔离测试记录", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, execute: async (input) => { document.body.dataset.saved = input.text; return JSON.stringify({ saved: input.text }); }, annotations: { readOnlyHint: true } });
      await document.modelContext.registerTool({ name: "pending", description: "可取消的隔离等待", inputSchema: { type: "object", additionalProperties: false }, execute: async (_, { signal }) => {
        document.body.dataset.started = String(Number(document.body.dataset.started ?? "0") + 1);
        return new Promise((_, reject) => signal.addEventListener("abort", () => { document.body.dataset.cancelled = "1"; reject(signal.reason); }, { once: true }));
      } });
    });
    const catalog = await f.run({ action: "webmcp_list", page: f.id });
    assert.equal(catalog.outcome, "observed", catalog.error);
    assert.equal(catalog.extensions.tools.length, 2);
    const tool = catalog.extensions.tools.find((item) => item.name === "update");
    assert.ok(tool);
    assert.equal((await f.run({ action: "webmcp_prepare", page: f.id, directory: catalog.extensions.directory, tool: tool.id, input: { text: "拒绝未批准" } })).outcome, "not_executed");
    await grant(f, "webmcp");
    const prepared = await f.run({ action: "webmcp_prepare", page: f.id, directory: catalog.extensions.directory, tool: tool.id, input: { text: "真实执行" } });
    assert.equal(prepared.outcome, "observed", prepared.error);
    const called = await f.run({ action: "webmcp_invoke", page: f.id, prepared: prepared.extensions.prepared, observation_mode: "none" });
    assert.equal(called.outcome, "executed", called.error);
    assert.equal(called.extensions.result.value.saved, "真实执行");
    assert.equal(await f.page.locator("body").getAttribute("data-saved"), "真实执行");
    assert.equal((await f.run({ action: "webmcp_invoke", page: f.id, prepared: prepared.extensions.prepared })).outcome, "not_executed");
    const current = await f.run({ action: "webmcp_list", page: f.id });
    const pending = current.extensions.tools.find((item) => item.name === "pending");
    const waiting = await f.run({ action: "webmcp_prepare", page: f.id, directory: current.extensions.directory, tool: pending.id, input: {} });
    const controller = new AbortController();
    const work = f.run({ action: "webmcp_invoke", page: f.id, prepared: waiting.extensions.prepared }, controller.signal, 5000);
    await f.page.waitForFunction(() => document.body.dataset.started === "1");
    controller.abort();
    const cancelled = await work;
    assert.equal(cancelled.outcome, "unknown", cancelled.error);
    await f.page.waitForFunction(() => document.body.dataset.cancelled === "1");
    assert.equal((await f.run({ action: "webmcp_invoke", page: f.id, prepared: waiting.extensions.prepared })).outcome, "not_executed");
    assert.equal(await f.page.locator("body").getAttribute("data-started"), "1");
  });
}
