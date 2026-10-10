import test from "node:test";
import assert from "node:assert/strict";
import { DeveloperLogs, boundedValue, diagnosticParams } from "../../../../modules/agent/web-runtime/dist/browser/diagnostics.js";

test("最大日志文本与URL仍能分页推进，Unicode输出严格受字节预算限制", () => {
  const logs = new DeveloperLogs();
  logs.event("Log.entryAdded", { entry: { level: "warning", text: "测".repeat(2000), url: "https://example.com/" + "测".repeat(2000) } });
  const result = logs.read(0, 100);
  assert.equal(result.entries.length, 1);
  assert.equal(result.next, 1);
  assert.equal(result.more, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
});

test("CDP精确方法和参数拒绝任意代码、网络、目标与文件入口", () => {
  for (const method of ["Runtime.evaluate", "Network.getResponseBody", "Target.getTargets", "Browser.getBrowserCommandLine", "IO.read", "Page.navigate", "DOM.setFileInputFiles"])
    assert.throws(() => diagnosticParams(method, {}));
  for (const key of ["sessionId", "contextId", "frameId", "url", "objectId", "backendNodeId", "constructor", "toString"])
    assert.throws(() => diagnosticParams("DOM.getDocument", { [key]: "other" }));
  assert.throws(() => diagnosticParams("DOM.getDocument", { pierce: true }));
  assert.deepEqual(diagnosticParams("DOM.getDocument", { depth: 2 }), { depth: 2 });
});

test("日志裁剪明确标记，控制字符也不会让第一条日志阻塞cursor", () => {
  const logs = new DeveloperLogs();
  logs.event("Log.entryAdded", { entry: { level: "error", text: "\0".repeat(4000), url: "\0".repeat(2000) } });
  const result = logs.read(0, 50);
  assert.equal(result.next, 1);
  assert.equal(result.entries[0].truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
});

test("超限诊断输出明确返回截断JSON文本", () => {
  const small = boundedValue({ value: "准确" });
  assert.equal(small.truncated, false);
  const large = boundedValue({ value: "测".repeat(32768) });
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.text) < 32768);
  assert.equal(large.value, undefined);
});
