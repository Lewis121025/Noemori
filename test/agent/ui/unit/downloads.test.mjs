import test from "node:test";
import assert from "node:assert/strict";
import { Downloads } from "../../../../modules/agent/web-runtime/dist/extension/downloads.js";
import { Operation } from "../../../../modules/agent/web-runtime/dist/extension/transport.js";

function fixture(send) {
  const calls = [];
  const transport = {
    async send(source, method, value) {
      calls.push({ method, value });
      return send(method, value);
    },
  };
  const downloads = new Downloads("owner", transport, {
    async artifact(value, signal) {
      if (signal.aborted) throw new Error("保存取消");
      return { bytes: Buffer.from(value.data, "base64").length };
    },
  });
  const page = {
    id: "page",
    frames: new Map([["frame", { id: "frame", session: { tabId: 1 }, world: 1 }]]),
    async expression() {},
  };
  const operation = () => new Operation(new AbortController().signal, performance.now() + 2000);
  const paused = {
    requestId: "original-post",
    frameId: "frame",
    request: { url: "https://fixture.test/report" },
    responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="report.txt"' }],
  };
  return { downloads, page, operation, paused, calls };
}

test("受管文件已保存后，浏览器响应回填失败不能改写为文件保存失败", async () => {
  const f = fixture(async (method) => {
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "body" };
    if (method === "IO.read") return { data: "原始内容", eof: true };
    if (method === "Fetch.fulfillRequest") throw new Error("用户已经关闭标签页");
    return {};
  });
  await f.downloads.arm(f.page, f.operation());
  await f.downloads.event(f.page, { tabId: 1 }, "Fetch.requestPaused", f.paused);
  const files = await f.downloads.wait(f.page.id, f.operation());
  assert.equal(files[0].status, "completed");
  assert.equal(files[0].bytes, Buffer.byteLength("原始内容"));
  assert.match(files[0].error, /回填|原生/);
  await f.downloads.close();
});

test("取消能关闭未结束的响应流，关闭会话不无限等待 IO.read", async () => {
  const read = Promise.withResolvers();
  const started = Promise.withResolvers();
  const f = fixture(async (method) => {
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "body" };
    if (method === "IO.read") {
      started.resolve();
      return read.promise;
    }
    if (method === "IO.close") read.reject(new Error("响应流关闭"));
    return {};
  });
  await f.downloads.arm(f.page, f.operation());
  const capture = f.downloads.event(f.page, { tabId: 1 }, "Fetch.requestPaused", f.paused);
  await started.promise;
  const closing = f.downloads.close();
  let timer;
  const result = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("hung"), 150);
    }),
  ]);
  clearTimeout(timer);
  // 红灯时解除测试用的悬挂读取，保证失败也不会遗留异步任务。
  if (result === "hung") read.resolve({ data: "", eof: true });
  await Promise.allSettled([capture, closing]);
  assert.equal(result, "closed");
  assert.ok(f.calls.some((call) => call.method === "IO.close"));
  assert.ok(!f.calls.some((call) => call.method === "Fetch.fulfillRequest"));
});
