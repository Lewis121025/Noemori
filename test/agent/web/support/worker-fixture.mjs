import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const inputLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = inputLines[Symbol.asyncIterator]();
const first = await iterator.next();
const input = JSON.parse(first.value);
if (input.mode === "wait" || input.mode === "error_child" || input.mode === "browser_properties") {
  process.stdout.write(
    JSON.stringify({
      kind: "browser_start",
      executable: chromium.executablePath(),
      proxy_url: "http://127.0.0.1:1",
    }) + "\n",
  );
  const response = await iterator.next();
  const lease = JSON.parse(response.value);
  if (input.mode === "browser_properties") {
    const browser = await chromium.connectOverCDP(lease.endpoint);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const webdriver = await page.evaluate(() => navigator.webdriver);
      process.stdout.write(
        JSON.stringify({
          kind: "finished",
          result: {
            url: "https://example.com",
            text: String(webdriver),
            truncated: false,
            warnings: [],
            images: [],
          },
        }) + "\n",
      );
    } finally {
      await browser.close();
    }
    inputLines.close();
    process.stdin.destroy();
  } else {
    writeFileSync(input.path, JSON.stringify({ parent: process.pid, child: lease.pid }));
    if (input.mode === "error_child") {
      process.stdout.write(
        JSON.stringify({ kind: "failed", error: "浏览器已启动时辅助进程异常退出" }) + "\n",
      );
      process.exit(1);
    }
    setInterval(() => {}, 1000);
  }
} else if (input.mode === "search_success") {
  process.stdout.write(
    JSON.stringify({
      kind: "search_finished",
      result: {
        url: "https://www.bing.com/search?q=fixture",
        html: '<li class="b_algo"><h2><a href="https://example.com/release">验证后的发布说明</a></h2><p>真实摘要</p></li>',
        warnings: ["部分资源未完成"],
      },
    }) + "\n",
  );
  inputLines.close();
  process.stdin.destroy();
} else if (input.mode === "stderr_only") {
  process.stderr.write("受控解析器异常：无法读取文档\n");
  process.exitCode = 1;
  inputLines.close();
  process.stdin.destroy();
} else if (input.mode === "invalid_frame") {
  process.stderr.write("受控协议异常：等待错误的宿主回复\n");
  process.stdout.write("{invalid}\n");
  setInterval(() => {}, 1000);
} else if (input.mode === "error") {
  process.stdout.write(
    JSON.stringify({ kind: "failed", error: "PDF 读取失败：文档需要密码" }) + "\n",
  );
  process.exitCode = 1;
  inputLines.close();
  process.stdin.destroy();
} else {
  process.stdout.write(
    JSON.stringify({
      kind: "finished",
      result: {
        url: "https://example.com",
        text: "正文",
        truncated: false,
        warnings: [],
        images: [],
      },
    }) + "\n",
  );
  inputLines.close();
  process.stdin.destroy();
}
