import test from "node:test";
import assert from "node:assert/strict";
import { BrowserProxyResolver } from "../../../../modules/agent/web-runtime/dist/browser/proxy.js";

test("不同来源分别匹配系统代理和绕过规则，同一来源共享未完成解析", async () => {
  const frames = [];
  const resolver = new BrowserProxyResolver(async (frame) => {
    frames.push(frame);
  });
  const proxied = resolver.resolve("https://public.example/one");
  const sameOrigin = resolver.resolve("https://public.example/two");
  const bypassed = resolver.resolve("http://localhost:3000/");
  assert.equal(frames.length, 2);
  resolver.accept({ kind: "proxy_ready", id: frames[1].id, proxy: null });
  resolver.accept({
    kind: "proxy_ready",
    id: frames[0].id,
    proxy: { server: "http://proxy.invalid:8080", username: "user", password: "private" },
  });
  assert.equal(await bypassed, undefined);
  assert.equal(await proxied, await sameOrigin);
  assert.equal((await proxied).resolve_hostname, true);
  resolver.close();
});

test("代理解析失败或宿主关闭不能悄悄回退为直连", async () => {
  const frames = [];
  const resolver = new BrowserProxyResolver(async (frame) => {
    frames.push(frame);
  });
  const rejected = resolver.resolve("https://denied.example/");
  resolver.accept({ kind: "proxy_ready", id: frames[0].id, error: "系统代理配置无效" });
  await assert.rejects(rejected, /代理配置/);
  const pending = resolver.resolve("https://pending.example/");
  resolver.close();
  await assert.rejects(pending, /已关闭/);
});
