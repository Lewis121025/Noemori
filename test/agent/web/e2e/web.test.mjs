import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pdfFixture } from "../support/fixtures.mjs";

const execute = promisify(execFile);
const binary = fileURLToPath(
  new URL("../../../../modules/agent/target/debug/examples/web", import.meta.url),
);

/** 用本地代理回放公开 IP 的响应，验证 Rust 与 Chromium 的完整读取路径，无外网依赖。 */
async function withProxy(run, { authenticated = false } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (
      authenticated &&
      request.headers["proxy-authorization"] !==
        `Basic ${Buffer.from("tester:fixture").toString("base64")}`
    ) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="fixture"' });
      response.end();
      return;
    }
    const path = new URL(request.url).pathname;
    if (["/managed-challenge", "/managed-unmarked", "/managed-ok"].includes(path)) {
      if (request.headers.cookie?.includes("clearance=fixture")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><title>验证后的文档</title><main><p>同一会话恢复后的真实正文。</p></main></html>",
        );
      } else {
        response.writeHead(
          path === "/managed-unmarked" ? 503 : path === "/managed-ok" ? 200 : 403,
          {
            "content-type": "text/html; charset=utf-8",
            ...(path === "/managed-challenge" ? { "cf-mitigated": "challenge" } : {}),
          },
        );
        response.end(`<html><main>正在检查浏览器。</main><script>window._cf_chl_opt={cType:'managed'};
          document.cookie='clearance=fixture; path=/';setTimeout(()=>location.reload(),300);</script></html>`);
      }
    } else if (path === "/unsupported-verification") {
      response.writeHead(403, {
        "content-type": "text/html; charset=utf-8",
        "cf-mitigated": "challenge",
      });
      response.end('<html><main><form id="challenge-form">请完成图片验证码。</form></main></html>');
    } else if (path === "/forbidden") {
      response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><main>Access denied.</main></html>");
    } else if (path === "/unavailable") {
      response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><main>Service unavailable.</main></html>");
    } else if (path === "/paper.pdf") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(pdfFixture(["hybrid", "text"]));
    } else if (
      path === "/browser-redirect" &&
      requests.filter((url) => url.endsWith("/browser-redirect")).length > 1
    ) {
      response.writeHead(302, { location: "http://127.0.0.1/private-fixture" });
      response.end();
    } else if (path === "/redirect") {
      response.writeHead(302, { location: "http://127.0.0.1/private" });
      response.end();
    } else if (path === "/missing") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><title>代理中的动态文档</title><main id="content" aria-busy="true">加载中...</main>
        <script>setTimeout(() => { const main = document.querySelector('#content');
          main.innerHTML = '<h1>动态正文</h1><p>这是通过同一个代理读取的完整内容。</p>';
          main.setAttribute('aria-busy', 'false'); }, 1200)</script></html>`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const proxy = `http://${authenticated ? "tester:fixture@" : ""}127.0.0.1:${address.port}`;
    const fetch = async (path) => {
      const { stdout } = await execute(binary, ["fetch", `http://93.184.215.14${path}`], {
        timeout: 70_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          HTTP_PROXY: proxy,
          http_proxy: proxy,
          HTTPS_PROXY: proxy,
          https_proxy: proxy,
          ALL_PROXY: "",
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
      });
      return JSON.parse(stdout);
    };
    await run(fetch, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("系统代理解析结果同时用于 Rust 下载与动态浏览器", async () => {
  await withProxy(async (fetch, requests) => {
    const result = await fetch("/dynamic");
    assert.equal(result.is_error, false);
    assert.equal(result.output.title, "代理中的动态文档");
    assert.match(result.output.text, /动态正文[\s\S]*完整内容/);
    assert.ok(requests.filter((url) => url.endsWith("/dynamic")).length >= 2);
  });
});

test("带认证的代理同时用于下载与浏览器网络", async () => {
  await withProxy(
    async (fetch) => {
      const result = await fetch("/dynamic");
      assert.equal(result.is_error, false, result.output.error);
      assert.match(result.output.text, /动态正文/);
    },
    { authenticated: true },
  );
});

test("浏览器阶段的重定向在请求发出前拒绝内网目标", async () => {
  await withProxy(async (fetch, requests) => {
    const result = await fetch("/browser-redirect");
    assert.equal(result.is_error, true);
    assert.match(result.output.error, /非公开/);
    assert.equal(
      requests.some((url) => url.includes("127.0.0.1/private-fixture")),
      false,
    );
  });
});

test("PDF 页图穿过完整 Rust 工具边界，正文不含图像字节", async () => {
  await withProxy(async (fetch) => {
    const result = await fetch("/paper.pdf");
    assert.equal(result.is_error, false);
    assert.equal(result.media_count, 2);
    assert.deepEqual(result.output.rendered_pages, [1, 2]);
    assert.match(result.output.text, /page 1[\s\S]*Release notes/);
    assert.equal(result.output.images, undefined);
  });
});

test("HTTP 错误和跳转到内网都成为明确的工具错误", async () => {
  await withProxy(async (fetch, requests) => {
    const missing = await fetch("/missing");
    assert.equal(missing.is_error, true);
    assert.match(missing.output.error, /HTTP 404/);
    const redirected = await fetch("/redirect");
    assert.equal(redirected.is_error, true);
    assert.match(redirected.output.error, /非公开/);
    assert.ok(!requests.some((url) => url.endsWith("/private")));
  });
});

test("HTTP 403、503 和 200 验证页进入浏览器，完成检查后在同一会话读取正文", async () => {
  await withProxy(async (fetch, requests) => {
    for (const path of ["/managed-challenge", "/managed-unmarked", "/managed-ok"]) {
      const result = await fetch(path);
      assert.equal(result.is_error, false, result.output.error);
      assert.equal(result.output.title, "验证后的文档");
      assert.match(result.output.text, /真实正文/);
      assert.ok(requests.filter((url) => url.endsWith(path)).length >= 3);
    }
  });
});

test("无法自动处理的验证明确回传，普通 HTTP 403 仍然保持访问失败", async () => {
  await withProxy(async (fetch) => {
    const challenge = await fetch("/unsupported-verification");
    assert.equal(challenge.is_error, true);
    assert.match(challenge.output.error, /人机验证.*人工.*图片题或音频题/);
    const forbidden = await fetch("/forbidden");
    assert.equal(forbidden.is_error, true);
    assert.match(forbidden.output.error, /HTTP 403/);
    const unavailable = await fetch("/unavailable");
    assert.equal(unavailable.is_error, true);
    assert.match(unavailable.output.error, /HTTP 503/);
  });
});
