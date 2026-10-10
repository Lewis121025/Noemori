import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { extractHtml } from "../../../../modules/agent/web-runtime/dist/html.js";
import { readPdf } from "../../../../modules/agent/web-runtime/dist/pdf.js";
import { assertPublicUrl } from "../../../../modules/agent/web-runtime/dist/network.js";
import {
  readSnapshot,
  waitForReadablePage,
} from "../../../../modules/agent/web-runtime/dist/page.js";
import { pdfFixture } from "../support/fixtures.mjs";

const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const { loadImage } = require("@napi-rs/canvas");
const limits = {
  max_chars: 30_000,
  max_pages: 6,
  image_edge: 640,
  max_download_bytes: 24 * 1024 * 1024,
};

async function withPage(run, options = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  try {
    await run(await browser.newPage(options));
  } finally {
    await browser.close();
  }
}

async function readPageSnapshot(t, page, url = "https://example.com/first") {
  const context = page.context();
  t.mock.method(chromium, "connectOverCDP", async () => ({
    newContext: async () => context,
    close: async () => {},
  }));
  t.mock.method(context, "newPage", async () => page);
  return readSnapshot({ operation: "page", url, limits, timeout_ms: 5000 }, async () => ({
    endpoint: "fixture",
    pid: process.pid,
  }));
}

test("正文提取保留表格与代码，并去除导航", () => {
  const html = `<html><title>版本文档</title><body><nav>全站导航</nav><main>
    <h1>发布说明</h1><p>这是完整的版本文档和接口说明。</p><aside>广告推荐</aside>
    <pre><code>const value = 42;\nreturn value;</code></pre>
    <table><thead><tr><th>版本</th><th>状态</th></tr></thead><tbody><tr><td>1.2.3</td><td>稳定</td></tr></tbody></table>
    <a href="/release">原始发布说明</a></main></body></html>`;
  const result = extractHtml(html, "https://example.com/docs", 30_000);
  assert.equal(result.title, "版本文档");
  assert.match(result.text, /```[\s\S]*const value = 42/);
  assert.match(result.text, /\|.*版本.*\|.*状态.*\|/);
  assert.match(result.text, /https:\/\/example.com\/release/);
  assert.doesNotMatch(result.text, /全站导航|广告推荐/);
  assert.equal(result.truncated, false);
});

test("真实 PDF 文本与扫描页保持原页码，图片尺寸受限", async () => {
  const result = await readPdf(
    pdfFixture(["text", "scan"]),
    "https://example.com/paper.pdf",
    limits,
  );
  assert.match(result.text, /第 1 页[\s\S]*Release notes/);
  assert.deepEqual(
    result.images.map((image) => image.page),
    [1, 2],
  );
  const image = await loadImage(Buffer.from(result.images[0].data, "base64"));
  assert.equal(image.height, 640);
  assert.equal(image.width, 480);
  assert.equal(result.truncated, false);
});

test("PDF 图片与正文超限明确标记截断，损坏文档明确失败", async () => {
  const scan = await readPdf(pdfFixture(["scan", "scan"]), "https://example.com/scan.pdf", {
    ...limits,
    max_pages: 1,
  });
  assert.equal(scan.images.length, 1);
  assert.equal(scan.truncated, true);
  const text = await readPdf(pdfFixture(["text", "text"]), "https://example.com/text.pdf", {
    ...limits,
    max_chars: 20,
  });
  assert.equal(Array.from(text.text).length, 20);
  assert.equal(text.truncated, true);
  await assert.rejects(
    readPdf(new Uint8Array([1, 2, 3]), "https://example.com/bad.pdf", limits),
    /PDF 读取失败/,
  );
});

test("带有页码文字的扫描页仍然作为图像返回", async () => {
  const result = await readPdf(pdfFixture(["hybrid"]), "https://example.com/hybrid.pdf", limits);
  assert.match(result.text, /page 1/);
  assert.deepEqual(
    result.images.map((image) => image.page),
    [1],
  );
});

test("公开目标限制覆盖 IPv4、IPv6 与非网络地址", async () => {
  for (const url of [
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://[::1]",
    "file:///tmp/private",
    "https://user:password@example.com",
  ]) {
    await assert.rejects(assertPublicUrl(url), /公开|HTTP/);
  }
});

test("动态文字读取等待异步正文，并释放浏览器", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><title>动态文档</title><main id="content">加载中...</main>
      <script>setTimeout(() => document.querySelector('#content').innerHTML = '<h1>异步正文</h1><p>加载后的内容</p>', 1500)</script></html>`);
    assert.equal(await waitForReadablePage(page), true);
    const result = extractHtml(await page.content(), "https://example.com/dynamic", 30_000);
    assert.match(result.text, /异步正文[\s\S]*加载后的内容/);
  } finally {
    await browser.close();
  }
});

test("正文稳定观察在同一预算内跨导航恢复，不等待已销毁文档的计时器", async () => {
  await withPage(async (page) => {
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<main>导航后的真实正文</main>",
      }),
    );
    await page.setContent("<main>加载中...</main>");
    await page.evaluate(() => {
      const root = document.querySelector("main");
      Object.defineProperty(root, "innerText", {
        get() {
          window.observed = true;
          return "加载中...";
        },
      });
    });
    const waiting = waitForReadablePage(page, 3000).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await page.waitForFunction(() => window.observed, undefined, { timeout: 1500 });
    await page.goto("https://example.com/cleared");
    const result = await waiting;
    if (result.error) throw result.error;
    assert.equal(result.value, true);
  });
});

test("页面脚本卡住时正文稳定观察仍受阶段预算约束", async () => {
  await withPage(async (page) => {
    await page.setContent("<main>加载中...</main>");
    await page.evaluate(() => {
      const root = document.querySelector("main");
      Object.defineProperty(root, "innerText", {
        get() {
          while (true) {}
        },
      });
    });
    const started = performance.now();
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("正文观察未遵守自己的截止时间")), 1500);
    });
    try {
      assert.equal(await Promise.race([waitForReadablePage(page, 250), guard]), false);
      assert.ok(performance.now() - started < 1500);
    } finally {
      clearTimeout(timer);
    }
  });
});

test("导航不能把上一文档的 HTML 与下一文档的来源 URL 拼成快照", async (t) => {
  await withPage(async (page) => {
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<main>文档 ${path}</main>`,
      });
    });
    const content = page.content.bind(page);
    t.mock.method(page, "content", async () => {
      const html = await content();
      // 在旧实现两个独立快照组件之间提交真实导航，确定性暴露跨文档拼接。
      await page.goto("https://example.com/second");
      return html;
    });
    const snapshot = await readPageSnapshot(t, page);
    assert.match(snapshot.html, new RegExp(`文档 ${new URL(snapshot.url).pathname}`));
  });
});

test("重定向响应先于文档提交时，快照重新采集并验证最终文档的 HTTP 状态", async (t) => {
  let requests = 0;
  let pendingResponse;
  let received;
  const pending = new Promise((resolve) => {
    received = resolve;
  });
  // 真实重定向通过本地代理，目标不返回响应头前不能提交新文档，也不会访问外部网站。
  const proxy = createServer((request, response) => {
    const path = new URL(request.url).pathname;
    if (path === "/pending") {
      pendingResponse = response;
      received();
    } else if (path !== "/first") {
      response.writeHead(204).end();
    } else if (++requests > 1) {
      response.writeHead(302, { location: "/pending" }).end();
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<main>旧文档的正文</main>");
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await withPage(
      async (page) => {
        const session = await page.context().newCDPSession(page);
        await session.send("Page.enable");
        const documents = [];
        session.on("Page.frameNavigated", ({ frame }) => {
          if (!frame.parentId) documents.push(frame.loaderId);
        });
        const wait = page.waitForFunction.bind(page);
        let reloading;
        t.mock.method(page, "waitForFunction", async (...args) => {
          const handle = await wait(...args);
          const value = await handle.jsonValue();
          if (!reloading && typeof value === "string" && Object.hasOwn(JSON.parse(value), "html")) {
            const snapshot = JSON.parse(value);
            assert.equal(snapshot.url, "http://example.com/first");
            assert.match(snapshot.html, /旧文档的正文/);
            const redirected = page.waitForEvent("response", {
              predicate: (response) =>
                response.url() === "http://example.com/first" && response.status() === 302,
              timeout: 1000,
            });
            reloading = page.reload({ timeout: 3000 }).then(
              () => undefined,
              (error) => error,
            );
            await redirected;
            await pending;
            assert.equal(documents.length, 1, "新响应不等于新文档已经提交");
            pendingResponse.writeHead(503, { "content-type": "text/html; charset=utf-8" });
            pendingResponse.end("<main>新文档</main>");
            assert.equal(await reloading, undefined);
            assert.equal(documents.length, 2);
          }
          return handle;
        });
        try {
          await assert.rejects(
            readPageSnapshot(t, page, "http://example.com/first"),
            /动态页面返回 HTTP 503/,
          );
        } finally {
          if (pendingResponse && !pendingResponse.writableEnded) {
            pendingResponse.writeHead(503, { "content-type": "text/html; charset=utf-8" });
            pendingResponse.end("<main>新文档</main>");
          }
          if (reloading) await reloading;
          await session.detach();
        }
      },
      { proxy: { server: `http://127.0.0.1:${proxy.address().port}` } },
    );
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("快照观察期间同 URL 新文档已经提交时，重新采集并验证新文档的 HTTP 状态", async (t) => {
  await withPage(async (page) => {
    let requests = 0;
    await page.route("**/*", (route) =>
      route.fulfill({
        status: ++requests === 1 ? 200 : 503,
        contentType: "text/html; charset=utf-8",
        body: "<main>当前文档的正文</main>",
      }),
    );
    const wait = page.waitForFunction.bind(page);
    let reloaded = false;
    t.mock.method(page, "waitForFunction", async (...args) => {
      const handle = await wait(...args);
      const value = await handle.jsonValue();
      if (!reloaded && typeof value === "string" && Object.hasOwn(JSON.parse(value), "html")) {
        reloaded = true;
        await page.reload();
      }
      return handle;
    });
    await assert.rejects(readPageSnapshot(t, page), /动态页面返回 HTTP 503/);
    assert.equal(reloaded, true);
  });
});

test("history 与 fragment 只改变同一文档的来源，仍沿用实际导航响应", async (t) => {
  await withPage(async (page) => {
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<main>同一文档的正文</main><script>
        setTimeout(() => { history.pushState({}, '', '/spa'); location.hash = 'section'; }, 100);
      </script>`,
      }),
    );
    const snapshot = await readPageSnapshot(t, page);
    assert.equal(snapshot.url, "https://example.com/spa#section");
    assert.match(snapshot.html, /同一文档的正文/);
  });
});

test("验证页明确失败，不能当成目标正文", () => {
  assert.throws(
    () =>
      extractHtml(
        '<main><form id="challenge-form">验证身份</form></main>',
        "https://example.com/doc",
        30_000,
      ),
    /人机验证/,
  );
});

test("Cloudflare 验证脚本不能作为正文成功返回，已签发 token 也不能替代页面通过检查", () => {
  for (const token of ["", "fixture-token"]) {
    const html = `<html><title>请稍候</title><main><p>正在检查您的浏览器。</p></main>
      <input type="hidden" name="cf-turnstile-response" value="${token}">
      <script>window._cf_chl_opt = { cType: 'managed' };</script></html>`;
    assert.throws(() => extractHtml(html, "https://example.com/doc", 30_000), /Cloudflare.*验证/);
  }
});

test("正常正文中的验证码表单不阻止读取公开文章", () => {
  const html = `<html><title>接口说明</title><main><h1>接口说明</h1><p>这是可以公开读取的文档正文。</p></main>
    <footer><form><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></form></footer></html>`;
  const result = extractHtml(html, "https://example.com/doc", 30_000);
  assert.match(result.text, /公开读取的文档正文/);
});

test("正文讨论人机验证时不能因关键词和页脚组件被误判为验证页", () => {
  const html = `<html><main><h1>人机验证</h1><p>本文介绍人机验证的接口与错误处理。</p></main>
    <footer><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></footer></html>`;
  assert.match(extractHtml(html, "https://example.com/docs", 30_000).text, /接口与错误处理/);
});
