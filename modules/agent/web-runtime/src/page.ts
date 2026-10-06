import { chromium, type BrowserContext, type Page, type Response } from "playwright-core";
import { createGateway, assertPublicUrl } from "./network.js";
import type { BrowserLease } from "./channel.js";
import { extractHtml } from "./html.js";
import type { HtmlSnapshot, ReadResult, WorkerInput } from "./contract.js";
import {
  resolveChallenge,
  challengeSignals,
  classifyChallenge,
  challengeReason,
  isCloudflareResource,
} from "./challenge.js";

/**
 * 等待可见文字短暂稳定；持续更新的页面有明确截止，不能无限等待 networkidle。
 * @param page 独占浏览器页面。
 * @param maximumWait 当前阶段允许等待的毫秒数，受工具剩余预算约束。
 * @returns 是否在截止前稳定。
 */
export async function waitForReadablePage(page: Page, maximumWait = 8000): Promise<boolean> {
  return page.evaluate(
    (maximumWait) =>
      new Promise<boolean>((resolve) => {
        let previous = "";
        let stableAt = Date.now();
        const started = Date.now();
        const timer = setInterval(() => {
          const root =
            document.querySelector<HTMLElement>("main, article, [role=main]") || document.body;
          const text = root?.innerText.trim() || "";
          const loading =
            /^(loading|加载中|正在加载|please wait)[.\s…]*$/i.test(text) ||
            Boolean(document.querySelector('[aria-busy="true"]'));
          if (text !== previous || !text || loading) {
            previous = text;
            stableAt = Date.now();
          }
          if (
            (text && !loading && Date.now() - stableAt >= 800 && Date.now() - started >= 2000) ||
            Date.now() - started >= maximumWait
          ) {
            clearInterval(timer);
            resolve(Boolean(text && !loading && Date.now() - stableAt >= 800));
          }
        }, 100);
      }),
    maximumWait,
  );
}

/**
 * 使用现有匿名浏览器读取公开 HTML，验证、下载和等待共同消耗宿主剩余预算。
 * @param input 已校验操作、代理和剩余预算。
 * @param startBrowser 宿主分配入口，辅助程序不能自行创建浏览器。
 * @returns 验证通过后的 HTML、最终 URL 及确实影响完整性的说明。
 * @throws 验证未通过、HTTP 失败、超限或浏览器异常时抛出明确原因。
 */
export async function readSnapshot(
  input: WorkerInput,
  startBrowser: (executable: string, proxyUrl: string) => Promise<BrowserLease>,
): Promise<HtmlSnapshot> {
  const deadline = performance.now() + input.timeout_ms;
  await assertPublicUrl(input.url);
  const gateway = await createGateway(input.proxy, input.limits.max_download_bytes);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const lease = await startBrowser(input.browser_path || chromium.executablePath(), gateway.url);
    browser = await chromium.connectOverCDP(lease.endpoint);
    const context = await browser.newContext({
      proxy: { server: gateway.url },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const result = await readDocument(context, input, deadline);
    result.warnings.push(...gateway.errors);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failures = [...gateway.errors];
    throw new Error(failures.length ? `${reason}；${failures.join("；")}` : reason);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await gateway.close();
    }
  }
}

/**
 * 将已经完成验证的 HTML 转成公开工具正文，不把内部 HTML 提交给模型。
 * @param input 页面操作及宿主预算。
 * @param startBrowser 宿主浏览器分配入口。
 * @returns 有明确截断说明的可读正文。
 * @throws 沿用读取错误；正文缺失或最终快照仍含验证时明确失败。
 */
export async function readPage(
  input: WorkerInput,
  startBrowser: (executable: string, proxyUrl: string) => Promise<BrowserLease>,
): Promise<ReadResult> {
  const snapshot = await readSnapshot(input, startBrowser);
  const result = extractHtml(snapshot.html, snapshot.url, input.limits.max_chars);
  result.warnings.push(...snapshot.warnings);
  return result;
}

async function readDocument(
  context: BrowserContext,
  input: WorkerInput,
  deadline: number,
): Promise<HtmlSnapshot> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const type = request.resourceType();
    const verification =
      isCloudflareResource(request.url()) || isCloudflareResource(request.frame().url());
    // 保留验证控件的图片与字体；普通页面沿用原预算策略，所有连接都经过受控出口。
    if (type === "media" || (["image", "font"].includes(type) && !verification))
      await route.abort();
    else await route.continue();
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  let transferred = 0;
  const overBudget = new Promise<never>((_, reject) => {
    session.on("Network.dataReceived", (event: { dataLength: number }) => {
      transferred += event.dataLength;
      if (transferred > input.limits.max_download_bytes)
        reject(new Error("动态网页下载超过配置的字节上限"));
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("网页读取超过宿主剩余时间预算")),
      Math.max(1, deadline - performance.now()),
    );
  });
  try {
    return await Promise.race([captureDocument(page, input, deadline), overBudget, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureDocument(
  page: Page,
  input: WorkerInput,
  deadline: number,
): Promise<HtmlSnapshot> {
  let response: Response | undefined;
  page.on("response", (received) => {
    if (received.request().isNavigationRequest() && received.frame() === page.mainFrame())
      response = received;
  });
  const initial = await page.goto(input.url, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(1, Math.min(30_000, deadline - performance.now())),
  });
  if (!initial) throw new Error("动态页面没有返回 HTTP 响应");
  if (!initial.ok() && ![403, 503].includes(initial.status()))
    throw new Error(`动态页面返回 HTTP ${initial.status()}`);
  await resolveChallenge(page, Math.min(20_000, Math.max(1, deadline - performance.now() - 1000)));
  let stable = await waitForReadablePage(
    page,
    Math.max(1, Math.min(8000, deadline - performance.now())),
  );
  const recovered = await resolveChallenge(
    page,
    Math.min(20_000, Math.max(1, deadline - performance.now() - 1000)),
  );
  if (recovered)
    stable = await waitForReadablePage(
      page,
      Math.max(1, Math.min(8000, deadline - performance.now())),
    );
  if (!response?.ok()) throw new Error(`动态页面返回 HTTP ${response?.status() ?? "未知"}`);
  await assertPublicUrl(page.url());
  const html = await page.content();
  if (Buffer.byteLength(html) > input.limits.max_download_bytes)
    throw new Error("动态网页 DOM 超过配置的字节上限");
  const challenge = classifyChallenge(await page.evaluate(challengeSignals));
  if (challenge.kind !== "none") throw new Error(challengeReason(challenge));
  return {
    url: page.url(),
    html,
    warnings: stable ? [] : ["页面正文在等待期限内未稳定，返回的是当前可读内容"],
  };
}
