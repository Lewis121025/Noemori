import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractHtml } from "../../../../modules/agent/web-runtime/dist/html.js";
import { readPdf } from "../../../../modules/agent/web-runtime/dist/pdf.js";
import { assertPublicUrl } from "../../../../modules/agent/web-runtime/dist/network.js";
import { waitForReadablePage } from "../../../../modules/agent/web-runtime/dist/page.js";
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
