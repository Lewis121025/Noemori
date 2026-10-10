import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { newConversation } from "../../../notes/desktop/support/workspace-actions";
import { mermaidExamples } from "../fixtures/mermaid";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("生产对话页面渲染全部内置 Mermaid 图表、公式和脚注，主题切换后仍可阅读", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-rich-message-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const answer = [
    "# 内容验收",
    "",
    "行内公式 $E=mc^2$，参考[^note]。",
    "",
    "$$",
    "\\frac{1}{2} + \\sqrt{x}",
    "$$",
    "",
    "| 左 | 右 |",
    "| :--- | ---: |",
    "| ==重点== | 内容 |",
    "",
    ...mermaidExamples.flatMap(([name, source]) => [
      `## ${name}`,
      "",
      "```mermaid",
      source,
      "```",
      "",
    ]),
    "[^note]: 完整脚注。",
  ].join("\n");
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 完整读取本地模型请求后再响应。 */
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } },
        ],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("测试模型未监听");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${join(root, "state")}`,
    ],
    cwd: fileURLToPath(desktop),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
    await page.evaluate(async (url) => {
      await window.noemori.agent.providersSave({
        protocol: "openai-chat",
        id: null,
        name: "渲染测试",
        address: { type: "endpoint", url },
        authentication: { type: "none" },
        models: [
          {
            id: "fixture",
            tools: false,
            streaming: false,
            vision: false,
            audio: false,
            video: false,
          },
        ],
      });
    }, `http://127.0.0.1:${address.port}/chat`);
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await newConversation(page);
    const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
    await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill("渲染验收");
    await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
    await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
    await page.getByRole("button", { name: "fixture", exact: true }).click();
    await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).fill("展示所有内容");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const message = page.locator('article[aria-label="助手"] .message-text');
    const charts = message.locator(".mermaid-content");
    await expect.poll(() => charts.count(), { timeout: 15000 }).toBe(mermaidExamples.length);
    await expect
      .poll(() => charts.locator("iframe, .preview-issue").count(), { timeout: 25000 })
      .toBe(mermaidExamples.length);
    const failures = await charts.evaluateAll((nodes) =>
      nodes.flatMap((node, index) =>
        node.querySelector(".preview-issue") ? [{ index, text: node.textContent }] : [],
      ),
    );
    expect(
      failures.map((failure) => ({ ...failure, type: mermaidExamples[failure.index]?.[0] })),
    ).toEqual([]);
    for (let index = 0; index < mermaidExamples.length; index++) {
      const svg = charts.nth(index).frameLocator("iframe").locator("body > svg");
      await svg.waitFor();
      const bounds = await svg.boundingBox();
      expect(bounds?.width, mermaidExamples[index]?.[0]).toBeGreaterThan(0);
      expect(bounds?.height, mermaidExamples[index]?.[0]).toBeGreaterThan(0);
      const labels = await svg.locator("text, foreignObject").allTextContents();
      expect(labels.join("").trim().length, mermaidExamples[index]?.[0]).toBeGreaterThan(0);
    }
    expect(await charts.first().frameLocator("iframe").locator("svg").textContent()).toContain(
      "开始",
    );
    await message.locator(".math-content.display mjx-container").waitFor();
    expect(await message.locator("mjx-container").count()).toBe(2);
    expect(await message.locator("mjx-merror").count()).toBe(0);
    expect(await message.locator('[aria-label="脚注"] li').textContent()).toContain("完整脚注");
    await charts.first().hover();
    await charts.first().getByRole("button", { name: "源码", exact: true }).click();
    expect(await charts.first().locator("pre code").textContent()).toBe(mermaidExamples[0][1]);
    await charts.first().getByRole("button", { name: "预览", exact: true }).click();
    await charts
      .first()
      .frameLocator("iframe")
      .locator("body > svg")
      .evaluate((node) => {
        node.setAttribute("data-preview-continuity", "kept");
      });
    await charts.first().getByRole("button", { name: "放大预览", exact: true }).click();
    const enlarged = charts.first().getByRole("dialog", { name: "图表放大预览", exact: true });
    await enlarged.waitFor();
    expect(
      await enlarged
        .frameLocator("iframe")
        .locator("body > svg")
        .getAttribute("data-preview-continuity"),
    ).toBe("kept");
    await page.keyboard.press("Escape");
    await enlarged.waitFor({ state: "hidden" });
    expect(
      await charts
        .first()
        .frameLocator("iframe")
        .locator("body > svg")
        .getAttribute("data-preview-continuity"),
    ).toBe("kept");
    expect(
      await charts
        .first()
        .getByRole("button", { name: "放大预览", exact: true })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    const firstSource = await charts.first().locator("iframe").getAttribute("srcdoc");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => charts.first().locator("iframe").getAttribute("srcdoc"))
      .not.toBe(firstSource);
    await expect
      .poll(() =>
        charts
          .first()
          .frameLocator("iframe")
          .locator("html")
          .evaluate((node) => getComputedStyle(node).colorScheme),
      )
      .toBe("dark");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
}, 60000);
