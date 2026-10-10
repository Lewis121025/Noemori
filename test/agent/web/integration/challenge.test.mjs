import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  observeDocument,
  resolveChallenge,
} from "../../../../modules/agent/web-runtime/dist/challenge.js";

const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");

async function withPage(run) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.NOEMORI_TEST_BROWSER
      ? { executablePath: process.env.NOEMORI_TEST_BROWSER }
      : {}),
  });
  try {
    await run(await browser.newPage());
  } finally {
    await browser.close();
  }
}

const content = "<html><main><h1>公开文档</h1><p>这是验证完成后真实出现的正文。</p></main></html>";

test("验证观察刚开始执行时发生导航，旧执行上下文销毁后仍检查新文档", async () => {
  await withPage(async (page) => {
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: content }),
    );
    await page.goto("https://example.com/first");
    const session = await page.context().newCDPSession(page);
    await session.send("Debugger.enable");
    const { breakpointId } = await session.send("Debugger.setInstrumentationBreakpoint", {
      instrumentation: "beforeScriptExecution",
    });
    const paused = new Promise((resolve) => session.once("Debugger.paused", resolve));
    // 暂停真实浏览器执行，确保导航破坏正在进行的观察，而非依赖定时器碰巧相遇。
    const checking = resolveChallenge(page, 3000).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused;
    await session.send("Debugger.removeBreakpoint", { breakpointId });
    await page.goto("https://example.com/cleared");
    const result = await checking;
    if (result.error) throw result.error;
    assert.equal(result.value, false);
    assert.equal(new URL(page.url()).pathname, "/cleared");
    await session.detach();
  });
});

test("只读观察的原始 JSON 在取回前再次导航也保持同一文档内容", async (t) => {
  await withPage(async (page) => {
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<main>${route.request().url()}</main>`,
      }),
    );
    await page.goto("https://example.com/first");
    const wait = page.waitForFunction.bind(page);
    t.mock.method(page, "waitForFunction", async (...args) => {
      const handle = await wait(...args);
      await page.goto("https://example.com/second");
      return handle;
    });
    const observation = JSON.parse(
      await observeDocument(
        page,
        "() => JSON.stringify({ url: location.href, text: document.querySelector('main').textContent })",
        2000,
      ),
    );
    assert.equal(observation.url, "https://example.com/first");
    assert.equal(observation.text, observation.url);
    assert.equal(page.url(), "https://example.com/second");
  });
});

test("普通 DOM 判据错误不会被当作导航重试", async () => {
  await withPage(async (page) => {
    await page.setContent("<main>正文</main>");
    await page.evaluate(() => {
      Object.defineProperty(document, "scripts", {
        get() {
          throw new Error("判据读取异常");
        },
      });
    });
    await assert.rejects(resolveChallenge(page, 1000), /判据读取异常/);
  });
});

test("自动检查导航后读取真正正文，沿用当前会话的 Cookie", async () => {
  await withPage(async (page) => {
    let cookie = "";
    await page.route("**/*", async (route) => {
      if (route.request().url().endsWith("/cleared")) {
        cookie = route.request().headers().cookie || "";
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: content });
      } else {
        await route.fulfill({
          status: 403,
          contentType: "text/html; charset=utf-8",
          body: `<html><main>正在检查浏览器。</main><script>window._cf_chl_opt = {cType:'managed'};
            document.cookie='clearance=fixture; path=/';
            setTimeout(() => location.href='/cleared', 300);</script></html>`,
        });
      }
    });
    await page.goto("https://example.com/challenge");
    assert.equal(await resolveChallenge(page, 3000), true);
    assert.match(await page.textContent("main"), /真实出现的正文/);
    assert.match(cookie, /clearance=fixture/);
  });
});

test("Turnstile 封闭 Shadow DOM 中的勾选能被操作，token 签发后仍等待目标正文", async () => {
  await withPage(async (page) => {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "challenges.cloudflare.com") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<body style="margin:0"><div id="root"></div><script>
            const root=document.querySelector('#root').attachShadow({mode:'closed'});
            const input=document.createElement('input'); input.type='checkbox';
            input.style='margin:16px;width:24px;height:24px';
            input.addEventListener('change',()=>parent.postMessage('verified','*'));
            root.append(input);</script></body>`,
        });
      } else if (url.pathname === "/cleared") {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: content });
      } else {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<html><main>请完成浏览器验证。</main><script>window._cf_chl_opt={cType:'interactive'};</script>
            <input name="cf-turnstile-response" value="">
            <iframe style="border:0;width:300px;height:65px" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget"></iframe>
            <script>addEventListener('message',event=>{
              if(event.origin==='https://challenges.cloudflare.com' && event.data==='verified'){
                document.querySelector('input').value='fixture-token';
                setTimeout(()=>location.href='/cleared',300);
              }
            });</script></html>`,
        });
      }
    });
    await page.goto("https://example.com/challenge");
    assert.equal(await resolveChallenge(page, 5000), true);
    assert.equal(new URL(page.url()).pathname, "/cleared");
    assert.match(await page.textContent("main"), /真实出现的正文/);
  });
});

test("验证没有清除时明确超时，不能凭 token 把验证页标记为成功", async () => {
  await withPage(async (page) => {
    await page.setContent(`<html><main>正在检查浏览器。</main>
      <script>window._cf_chl_opt={cType:'managed'};</script>
      <input name="cf-turnstile-response" value="fixture-token"></html>`);
    const started = performance.now();
    await assert.rejects(resolveChallenge(page, 250), /Cloudflare.*验证.*自动处理超时/);
    assert.ok(performance.now() - started < 2000);
  });
});

test("需要图片或音频的验证明确报告提供方，不尝试无限重试", async () => {
  await withPage(async (page) => {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      '<form><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></form>',
    );
    await assert.rejects(resolveChallenge(page, 1000), /reCAPTCHA.*人工.*图片题或音频题/);
  });
});

test("多个不可操作的控件仍共享三次尝试上限", async () => {
  await withPage(async (page) => {
    await page.route("https://challenges.cloudflare.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<input type="checkbox" disabled>',
      }),
    );
    await page.setContent(
      `<script>window._cf_chl_opt={cType:'interactive'};</script>${Array.from(
        { length: 4 },
        (_, index) =>
          `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget?id=${index}"></iframe>`,
      ).join("")}`,
    );
    await assert.rejects(resolveChallenge(page, 4500), /已尝试 3 次控件操作/);
  });
});

test("同一控件首次未通过时允许有限重试，成功后仍核验正文", async () => {
  await withPage(async (page) => {
    await page.route("https://challenges.cloudflare.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<input type="checkbox"><script>
        let attempts=0; const input=document.querySelector('input');
        input.addEventListener('change',()=>{
          attempts++;
          if(attempts===1) setTimeout(()=>input.checked=false,100);
          else parent.postMessage('verified','*');
        });</script>`,
      }),
    );
    await page.setContent(`<script>window._cf_chl_opt={cType:'interactive'};</script>
      <main>正在检查浏览器。</main>
      <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget"></iframe>
      <script>addEventListener('message',event=>{
        if(event.origin==='https://challenges.cloudflare.com'&&event.data==='verified'){
          document.querySelector('main').innerHTML='<p>验证完成后的真实正文。</p>';
          for(const element of document.querySelectorAll('iframe,script')) element.remove();
        }
      });</script>`);
    assert.equal(await resolveChallenge(page, 6500), true);
    assert.match(await page.textContent("main"), /真实正文/);
  });
});

test("页面脚本卡住时验证阶段仍按自己的预算结束", async () => {
  await withPage(async (page) => {
    await page.setContent(
      "<script>window._cf_chl_opt={cType:'managed'};</script><main>正在检查浏览器。</main>",
    );
    await page.evaluate(() =>
      setTimeout(() => {
        while (true) {}
      }, 100),
    );
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("验证阶段未遵守自己的截止时间")), 1500);
    });
    try {
      await assert.rejects(Promise.race([resolveChallenge(page, 250), guard]), /自动处理超时/);
    } finally {
      clearTimeout(timer);
    }
  });
});
