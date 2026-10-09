import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionBrowser } from "../../../../modules/agent/web-runtime/dist/extension/browser.js";

test("关闭会话等待专用窗口创建结算，并清理关闭后才出现的任务标签页", async (t) => {
  const created = Promise.withResolvers();
  const started = Promise.withResolvers();
  const removed = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    windows: { create() { started.resolve(); return created.promise; } },
    tabs: { async remove(id) { removed.push(id); } },
  };
  t.after(() => { globalThis.chrome = previous; });
  const browser = new ExtensionBrowser("session", "connection", {}, {}, () => {});
  const opening = browser.execute({ action: "open", url: "https://example.test" }, new AbortController().signal, 5000);
  await started.promise;
  let closed = false;
  const closing = browser.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const completedEarly = closed;
  created.resolve({ id: 42, tabs: [{ id: 123 }] });
  await Promise.all([opening, closing]);
  assert.equal(completedEarly, false);
  assert.deepEqual(removed, [123]);
});
