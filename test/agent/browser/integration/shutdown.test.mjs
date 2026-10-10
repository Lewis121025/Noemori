import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "../../ui/support/browser.mjs";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../../../../modules/agent/web-runtime/dist/browser/main.js", import.meta.url));

test("真实worker关闭扩展CDP时先停止通知并交付closed，不报告正常断开为failed", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, "<title>关闭验证</title><button>目标</button>");
  const directory = await mkdtemp(join(tmpdir(), "noemori-worker-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close"); } });
  const output = [], unread = [];
  let waiter;
  let stderr = "";
  let ended;
  child.stderr.on("data", (bytes) => { stderr += String(bytes); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    output.push(value);
    if (waiter) { const done = waiter; waiter = undefined; done.resolve(value); }
    else unread.push(value);
  });
  const stop = (error) => { ended = error; if (waiter) { waiter.reject(error); waiter = undefined; } };
  child.on("error", stop);
  child.on("close", (code, signal) => stop(new Error(`浏览器worker提前结束：code=${code}, signal=${signal}; ${stderr}`)));
  const next = () => unread.length ? Promise.resolve(unread.shift()) : ended ? Promise.reject(ended) : new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  send({ workspace: directory, download_directory: directory, browser_path: null, private_origins: [f.origin], max_pages: 8, max_chars: 12000, max_elements: 100, max_download_bytes: 1048576, max_network_bytes: 1048576 });
  assert.equal((await next()).kind, "browser_start");
  send({ kind: "browser_ready", endpoint: f.transport.socket.url, embedded: false });
  while ((await next()).kind !== "ready") {}
  send({ kind: "execute", id: "open", timeout_ms: 5000, action: { action: "open", url: f.origin } });
  let opened;
  for (;;) { const value = await next(); if (value.kind === "result") { opened = value.result; break; } }
  assert.equal(opened.outcome, "executed", opened.error);
  send({ kind: "execute", id: "extensions", timeout_ms: 5000, action: { action: "capabilities_list", page: opened.observation.page } });
  while ((await next()).kind !== "result") {}
  const closing = output.length;
  const exited = once(child, "close");
  send({ kind: "close" });
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(output.slice(closing).some((value) => value.kind === "failed"), false, JSON.stringify(output.slice(closing)));
  assert.equal(output.slice(closing).some((value) => value.kind === "state"), false, JSON.stringify(output.slice(closing)));
  assert.equal(output.at(-1).kind, "closed");
  assert.equal(stderr.includes("EPIPE"), false, stderr);
});

test("真实worker在浏览器启动握手期间关闭也回收网关并确认closed", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-worker-start-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close"); } });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += String(bytes); });
  const input = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ workspace: directory, download_directory: directory, browser_path: null, private_origins: [], max_pages: 8, max_chars: 12000, max_elements: 100, max_download_bytes: 1048576, max_network_bytes: 1048576 }) + "\n");
  const first = await input.next();
  if (first.done) throw new Error(`浏览器worker在启动前结束：${stderr}`);
  assert.equal(JSON.parse(first.value).kind, "browser_start");
  const exited = once(child, "close");
  child.stdin.write(JSON.stringify({ kind: "close" }) + "\n");
  const frames = [];
  for await (const line of input) frames.push(JSON.parse(line));
  assert.equal((await exited)[0], 0, stderr);
  assert.deepEqual(frames.map((frame) => frame.kind), ["closed"]);
  assert.equal(stderr.includes("EPIPE"), false, stderr);
});
