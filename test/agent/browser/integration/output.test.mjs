import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { fixture } from "../../ui/support/browser.mjs";
import { outputPeer } from "../../web/support/output-peer.mjs";

const worker = new URL(
  "../../../../modules/agent/web-runtime/dist/browser/main.js",
  import.meta.url,
);

async function settings(t, origins = []) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-worker-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    workspace: directory,
    download_directory: directory,
    browser_path: null,
    private_origins: origins,
    max_pages: 8,
    max_chars: 12000,
    max_elements: 100,
    max_download_bytes: 1048576,
    max_network_bytes: 1048576,
  };
}

async function failedOutput(peer) {
  assert.equal((await peer.exited)[0], 1, peer.stderr());
  assert.match(peer.stderr(), /控制输出失败.*EPIPE/s);
  assert.doesNotMatch(
    peer.stderr(),
    /Unhandled 'error' event|node:events:|node:internal\/process\/promises/,
  );
}

async function gatewayReleased(frame) {
  const endpoint = new URL(frame.proxy_url);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(endpoint.port), endpoint.hostname, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

test(
  "浏览器首个控制输出的消费端已关闭时，报告EPIPE并回收初始化网关",
  { timeout: 10000 },
  async (t) => {
    const config = await settings(t);
    const peer = outputPeer(t, worker);
    peer.disconnect();
    await peer.send(config);
    await failedOutput(peer);
  },
);

test("浏览器握手失败的诊断遇到断管时仍回收网关并保留两个错误", { timeout: 10000 }, async (t) => {
  const peer = outputPeer(t, worker);
  await peer.send(await settings(t));
  const frame = JSON.parse((await peer.frames.next()).value);
  assert.equal(frame.kind, "browser_start");
  peer.disconnect();
  await peer.send({ kind: "invalid" });
  await failedOutput(peer);
  assert.match(peer.stderr(), /宿主未提供浏览器租约/);
  await gatewayReleased(frame);
});

test("浏览器执行结果遇到断管时终结会话并释放页面、CDP与网关", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, "<title>输出断开</title>");
  const previous = await f.transport.command("Target.getBrowserContexts");
  const peer = outputPeer(t, worker);
  await peer.send(await settings(t, [f.origin]));
  const frame = JSON.parse((await peer.frames.next()).value);
  assert.equal(frame.kind, "browser_start");
  await peer.send({ kind: "browser_ready", endpoint: f.transport.socket.url, embedded: false });
  for (;;) {
    const line = await peer.frames.next();
    assert.equal(line.done, false, peer.stderr());
    if (JSON.parse(line.value).kind === "ready") break;
  }
  peer.disconnect();
  await peer.send({ kind: "execute", id: "tabs", timeout_ms: 5000, action: { action: "tabs" } });
  await failedOutput(peer);
  assert.deepEqual(await f.transport.command("Target.getBrowserContexts"), previous);
  await gatewayReleased(frame);
});

test(
  "浏览器启动期间有限输入中的close帧在EOF后仍完成资源关闭握手",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, "<title>有限控制输入</title>");
    const peer = outputPeer(t, worker);
    await peer.send(await settings(t));
    const frame = JSON.parse((await peer.frames.next()).value);
    assert.equal(frame.kind, "browser_start");
    peer.child.stdin.end(
      JSON.stringify({ kind: "browser_ready", endpoint: f.transport.socket.url, embedded: false }) +
        "\n" +
        JSON.stringify({ kind: "close" }) +
        "\n",
    );
    const frames = [];
    for await (const line of peer.frames) frames.push(JSON.parse(line));
    assert.equal((await peer.exited)[0], 0, peer.stderr());
    assert.equal(frames.at(-1).kind, "closed");
    assert.equal(
      frames.some((value) => value.kind === "failed"),
      false,
    );
    await gatewayReleased(frame);
  },
);
