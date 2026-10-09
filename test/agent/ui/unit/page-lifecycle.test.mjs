import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionPage } from "../../../../modules/agent/web-runtime/dist/extension/page.js";

test("关闭等待正在建立的 debugger 连接，迟到附着不能遗留控制权", async () => {
  const attached = Promise.withResolvers();
  let detachCount = 0;
  const transport = {
    attach: () => attached.promise,
    async detach() {
      detachCount++;
    },
    async send(_source, method) {
      return method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "frame", url: "https://fixture.test" } } }
        : {};
    },
  };
  const page = new ExtensionPage("page", 1, transport, {
    async arm() {},
    async event() {},
    hint() {},
  });
  const starting = page.attach().catch((error) => error);
  let closed = false;
  const closing = page.detach().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closedBeforeAttach = closed;
  attached.resolve();
  await Promise.all([starting, closing]);
  assert.equal(closedBeforeAttach, false, "连接尚未结算时不能确认释放完成");
  assert.equal(detachCount, 1, "迟到附着必须被释放");
});
