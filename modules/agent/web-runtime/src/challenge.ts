import { errors, type Frame, type Page } from "playwright-core";

/** 验证观察只包含判据，不把 Cookie、验证码 token 或页面内部标识交给模型。 */
export type ChallengeSignals = {
  cloudflare: boolean;
  interactive: boolean;
  turnstile: boolean;
  token: boolean;
  readable: boolean;
  provider: string | null;
};

/** 自动流程只处理浏览器检查与 Turnstile；其他验证必须明确报告所需操作。 */
export type Challenge =
  | { kind: "none" }
  | { kind: "cloudflare"; mode: "managed" | "interactive" | "embedded" }
  | { kind: "unsupported"; provider: string };

/** 阶段截止是终止状态，不能被当作框架分离或单次控件超时继续重试。 */
class ChallengeTimeoutError extends Error {}

/**
 * 收集 DOM 判据；函数自包含，既能在浏览器执行，也能检查不执行脚本的 HTML 快照。
 * @param input 页面文档；省略时读取浏览器当前 document。
 * @returns 验证提供方、是否仍有阻挡及公开正文是否已经出现。
 */
export function challengeSignals(input: Document | void = document): ChallengeSignals {
  const root = input || document;
  const scripts = Array.from(root.scripts);
  const options = scripts.map((script) => script.textContent || "").join("\n");
  const cloudflare =
    /(?:window\.)?_cf_chl_opt\s*=/.test(options) ||
    Boolean(root.querySelector("#challenge-running, #challenge-stage, #cf-challenge-running"));
  const interactive = /\bcType\s*:\s*['"]interactive['"]/.test(options);
  const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>("iframe[src]"));
  const sources = [...scripts.map((script) => script.src), ...frames.map((frame) => frame.src)];
  const urls = sources.flatMap((source) =>
    source && URL.canParse(source, root.baseURI) ? [new URL(source, root.baseURI)] : [],
  );
  const turnstile = urls.some((url) => {
    return (
      url.hostname === "challenges.cloudflare.com" &&
      /^\/(?:turnstile\/|cdn-cgi\/challenge-platform\/)/.test(url.pathname)
    );
  });
  const content = (root.querySelector("main, article, [role=main]") || root.body)?.cloneNode(true);
  let readable = false;
  if (root.defaultView && content instanceof root.defaultView.Element) {
    for (const node of content.querySelectorAll(
      "script, style, nav, header, footer, aside, form, iframe, input, button, [hidden], [aria-hidden=true], .cf-turnstile, #cf-turnstile",
    ))
      node.remove();
    const text = (content.textContent || "").trim();
    readable = Boolean(
      text &&
      !/^(?:loading|加载中|正在加载|please wait)[.\s…]*$/i.test(text) &&
      !/^(?:verify (?:that )?you are human|checking (?:your browser|if the site connection)|please (?:verify|complete).{0,50}(?:verification|check)|请完成.{0,8}验证|正在检查|验证身份)/i.test(
        text,
      ),
    );
  }
  let provider: string | null = null;
  if (
    urls.some(
      (url) =>
        /(^|\.)(?:google\.com|recaptcha\.net)$/.test(url.hostname) &&
        url.pathname.startsWith("/recaptcha/"),
    )
  )
    provider = "reCAPTCHA";
  else if (urls.some((url) => /(^|\.)hcaptcha\.com$/.test(url.hostname))) provider = "hCaptcha";
  else if (root.querySelector("#b_captcha, form#challenge-form, #captcha, .captcha"))
    provider = "搜索源或网站验证码";
  return {
    cloudflare,
    interactive,
    turnstile,
    token: Array.from(
      root.querySelectorAll<HTMLInputElement>('[name="cf-turnstile-response"]'),
    ).some((input) => Boolean(input.value.trim())),
    readable,
    provider,
  };
}

/**
 * 区分阻挡正文的验证与正常页面中的表单；签发 token 不能代替目标正文检查。
 * @param signals 当前文档观察。
 * @returns 当前必须处理的验证状态。
 */
export function classifyChallenge(signals: ChallengeSignals): Challenge {
  if (signals.cloudflare)
    return { kind: "cloudflare", mode: signals.interactive ? "interactive" : "managed" };
  if (signals.turnstile && !signals.readable) return { kind: "cloudflare", mode: "embedded" };
  if (signals.provider && !signals.readable)
    return { kind: "unsupported", provider: signals.provider };
  return { kind: "none" };
}

/** 将未通过的验证转为明确错误，避免调用方把验证页当成有效观察。 */
export function challengeReason(challenge: Exclude<Challenge, { kind: "none" }>): string {
  if (challenge.kind === "cloudflare") return "Cloudflare 人机验证尚未通过，未取得目标正文";
  return `${challenge.provider} 人机验证需要人工处理；本次不支持图片题或音频题，未取得目标正文`;
}

function cloudflareFrame(frame: Frame): boolean {
  if (!URL.canParse(frame.url())) return false;
  const url = new URL(frame.url());
  return (
    url.hostname === "challenges.cloudflare.com" &&
    url.pathname.startsWith("/cdn-cgi/challenge-platform/")
  );
}

/** 仅为 Cloudflare 自身及其框架放行验证资产；实际公开地址仍由网络出口校验。 */
export function isCloudflareResource(source: string): boolean {
  if (!URL.canParse(source)) return false;
  const url = new URL(source);
  return ["http:", "https:"].includes(url.protocol) && url.hostname === "challenges.cloudflare.com";
}

async function clickWidget(page: Page, frame: Frame, timeout: number): Promise<boolean> {
  const checkbox = frame.getByRole("checkbox").first();
  if (await checkbox.isVisible()) {
    await checkbox.check({ timeout });
    return true;
  }
  // Cloudflare 的封闭 Shadow DOM 不暴露 checkbox；只在真实可见的供应方框架内点击。
  const element = await frame.frameElement();
  try {
    const box = await element.boundingBox();
    if (!box || box.width < 50 || box.height < 50) return false;
    await element.scrollIntoViewIfNeeded({ timeout });
    const position = await element.boundingBox();
    if (!position) return false;
    await page.mouse.click(position.x + 28, position.y + 28);
    return true;
  } finally {
    await element.dispose();
  }
}

// DOM 观察也可能被页面脚本卡住；不能只在循环之间检查时钟，必须约束正在等待的操作。
async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  failure: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), Math.max(1, deadline - performance.now()));
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在同一浏览器会话内等待自动检查或操作 Turnstile，最多三次控件操作。
 * @param page 当前匿名页面，网络与进程仍由原宿主拥有。
 * @param timeout 本阶段剩余毫秒预算，必须为正值。
 * @returns 是否确实从验证页恢复到可读正文。
 * @throws 不支持的验证、预算耗尽或浏览器异常时返回明确原因。
 */
export async function resolveChallenge(page: Page, timeout: number): Promise<boolean> {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("人机验证时间预算必须为正数");
  const deadline = performance.now() + timeout;
  const attempted = new Map<Frame, number>();
  let seen: Exclude<Challenge, { kind: "none" }> | undefined;
  let attempts = 0;
  let lastFailure = "";
  const expired = () => {
    const reason = seen ? challengeReason(seen) : "人机验证检查超过时间预算";
    return new ChallengeTimeoutError(
      `${reason}；自动处理超时，已尝试 ${attempts} 次控件操作${lastFailure ? `；${lastFailure}` : ""}`,
    );
  };
  while (performance.now() < deadline) {
    const signals = await beforeDeadline(page.evaluate(challengeSignals), deadline, expired);
    const challenge = classifyChallenge(signals);
    if (challenge.kind === "unsupported") throw new Error(challengeReason(challenge));
    if (challenge.kind === "none") {
      if (!seen) return false;
      if (signals.readable) return true;
    } else {
      seen = challenge;
      if (!signals.token && attempts < 3) {
        for (const frame of page.frames()) {
          if (attempts >= 3 || performance.now() >= deadline) break;
          if (frame === page.mainFrame() || frame.isDetached()) continue;
          const previous = attempted.get(frame);
          // 控件未通过时允许重试同一框架，但先留出服务端检查时间，不能连续点击刷新验证。
          if (previous !== undefined && performance.now() - previous < 5000) continue;
          if (!cloudflareFrame(frame)) continue;
          try {
            const click = clickWidget(
              page,
              frame,
              Math.max(1, Math.min(1000, deadline - performance.now())),
            );
            if (await beforeDeadline(click, deadline, expired)) {
              attempted.set(frame, performance.now());
              attempts++;
              break;
            }
          } catch (error) {
            if (error instanceof ChallengeTimeoutError) throw error;
            if (!(error instanceof errors.TimeoutError) && !frame.isDetached()) throw error;
            attempted.set(frame, performance.now());
            attempts++;
            lastFailure =
              (error instanceof Error ? error.message : String(error)).split("\n")[0] ||
              "验证控件操作失败";
          }
        }
      }
    }
    await page.waitForTimeout(Math.max(1, Math.min(200, deadline - performance.now())));
  }
  throw expired();
}
