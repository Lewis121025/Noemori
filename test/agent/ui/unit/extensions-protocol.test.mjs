import test from "node:test";
import assert from "node:assert/strict";
import { PageExtensions } from "../../../../modules/agent/web-runtime/dist/browser/extensions.js";

// 夹具严格使用官方 experimental WebMCP CDP 形状；不能用它宣称真实浏览器支持。
function fixture({ supported = true, respond = true } = {}) {
  const calls = [];
  let extensions;
  const definition = { name: "update", frameId: "root", description: "更新测试记录", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnly: true } };
  const protocol = { async send(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://example.com/", loaderId: "real-loader" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 123 };
    if (method === "Runtime.evaluate") return { result: { value: true } };
    if (method === "WebMCP.enable") {
      if (!supported) throw new Error("Protocol error: 'WebMCP.enable' wasn't found");
      extensions.event("WebMCP.toolsAdded", { tools: [definition] });
    }
    if (method === "WebMCP.invokeTool") {
      if (respond) queueMicrotask(() => extensions.event("WebMCP.toolResponded", { invocationId: "call-1", status: "Completed", output: { nested: { value: params.input.text } } }));
      return { invocationId: "call-1" };
    }
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800 } };
    return {};
  } };
  extensions = new PageExtensions(protocol);
  const execution = (signal = new AbortController().signal, budget = 5000) => {
    let dispatched = false;
    return { signal, check() { if (signal.aborted) throw new Error("cancelled"); }, budget: () => budget, dispatch() { this.check(); dispatched = true; }, get dispatched() { return dispatched; } };
  };
  const run = (action, operation = execution()) => extensions.execute({ page: "page", ...action }, operation);
  const grant = async (capability) => {
    const state = await run({ action: "extension_state" });
    return run({ action: "grant_capability", ...state, capability });
  };
  return { extensions, calls, run, grant, execution, definition };
}

test("不支持WebMCP的协议后端不广告，其他诊断能力仍可发现", async () => {
  const f = fixture({ supported: false });
  const state = await f.run({ action: "capabilities_list" });
  assert.deepEqual(state.capabilities.map((item) => item.name), ["developer_logs", "cdp"]);
  await assert.rejects(f.run({ action: "webmcp_list" }), /未提供/);
  await assert.rejects(f.run({ action: "capability_get", name: "webmcp" }), /未提供/);
});

test("readOnly工具仍须独立审批，Schema准备输入被冻结且token仅消费一次", async () => {
  const f = fixture();
  const catalog = await f.run({ action: "webmcp_list" });
  const tool = catalog.tools[0];
  assert.equal(tool.annotations.readOnly, true);
  await assert.rejects(f.run({ action: "webmcp_prepare", directory: catalog.directory, tool: tool.id, input: { text: "值" } }), /用户授权/);
  await f.grant("webmcp");
  const input = { text: "冻结" };
  const prepared = await f.run({ action: "webmcp_prepare", directory: catalog.directory, tool: tool.id, input });
  input.text = "变更";
  assert.equal(prepared.input.text, "冻结");
  assert.deepEqual(prepared.schema, tool.input_schema);
  const operation = f.execution();
  const result = await f.run({ action: "webmcp_invoke", prepared: prepared.prepared }, operation);
  assert.equal(operation.dispatched, true);
  assert.equal(result.result.value.nested.value, "冻结");
  assert.equal(result.untrusted, true);
  await assert.rejects(f.run({ action: "webmcp_invoke", prepared: prepared.prepared }), /已消费/);
  assert.equal(f.calls.filter((call) => call.method === "WebMCP.invokeTool").length, 1);
});

test("工具更新、导航与审批中目录变化都拒绝旧身份", async () => {
  const f = fixture();
  const state = await f.run({ action: "extension_state" });
  f.extensions.event("WebMCP.toolsAdded", { tools: [{ ...f.definition, description: "新的工具" }] });
  await assert.rejects(f.run({ action: "grant_capability", ...state, capability: "webmcp" }), /审批期间/);
  await f.grant("webmcp");
  const catalog = await f.run({ action: "webmcp_list" });
  const prepared = await f.run({ action: "webmcp_prepare", directory: catalog.directory, tool: catalog.tools[0].id, input: { text: "旧文档" } });
  f.extensions.event("Page.frameNavigated", { frame: { id: "root", url: "https://other.example/", loaderId: "new-loader" } });
  await assert.rejects(f.run({ action: "webmcp_invoke", prepared: prepared.prepared }), /用户授权/);
  assert.equal(f.calls.filter((call) => call.method === "WebMCP.invokeTool").length, 0);
});

test("接管失效后必须重新授权，重复enable仍从真实事件重发现工具", async () => {
  const f = fixture();
  await f.grant("webmcp");
  const before = await f.run({ action: "webmcp_list" });
  f.extensions.invalidate();
  const after = await f.run({ action: "webmcp_list" });
  assert.equal(after.tools.length, 1);
  assert.notEqual(after.directory, before.directory);
  assert.notEqual(after.tools[0].id, before.tools[0].id);
  assert.equal(after.granted, false);
});

test("取消WebMCP等待调用cancelInvocation并撤销token，不重放未知副作用", async () => {
  const f = fixture({ respond: false });
  await f.grant("webmcp");
  const catalog = await f.run({ action: "webmcp_list" });
  const prepared = await f.run({ action: "webmcp_prepare", directory: catalog.directory, tool: catalog.tools[0].id, input: { text: "执行一次" } });
  const controller = new AbortController();
  const operation = f.execution(controller.signal);
  const work = f.run({ action: "webmcp_invoke", prepared: prepared.prepared }, operation);
  while (!f.calls.some((call) => call.method === "WebMCP.invokeTool")) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(work, /取消|cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operation.dispatched, true);
  assert.equal(f.calls.filter((call) => call.method === "WebMCP.cancelInvocation").length, 1);
  await assert.rejects(f.run({ action: "webmcp_invoke", prepared: prepared.prepared }), /失效|已消费/);
  assert.equal(f.calls.filter((call) => call.method === "WebMCP.invokeTool").length, 1);
});

test("初始化期间导航不登记迟到结果，也不把旧批准写入新文档", async () => {
  let release;
  let extensions;
  const held = new Promise((resolve) => { release = resolve; });
  const protocol = { async send(method) {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://example.com/" } } };
    if (method === "Runtime.enable") await held;
    if (method === "WebMCP.enable") throw new Error("unknown method");
    return {};
  } };
  extensions = new PageExtensions(protocol);
  const execution = { signal: new AbortController().signal, check() {}, budget: () => 5000, dispatch() {} };
  const work = extensions.execute({ action: "extension_state", page: "page" }, execution);
  await new Promise((resolve) => setImmediate(resolve));
  extensions.event("Page.frameNavigated", { frame: { id: "root", url: "https://other.example/" } });
  release();
  await assert.rejects(work, /页面改变/);
});
