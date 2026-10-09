import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { noteAction } from "../../../notes/desktop/support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("选区添加和拖拽只复制原文，引用跨重载恢复并进入实际模型请求，大小窗口均可预览和定位", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-reference-journey-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const vault = join(directory, "vault"),
    state = join(directory, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const original =
    "# 引用验收\n\n第一段值得引用的文字😀。\n\n第二段也可以拖入对话。\n" +
    Array.from({ length: 80 }, (_, index) => `\n第 ${index} 行补充资料。\n`).join("");
  await writeFile(join(vault, "引用.md"), original);
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({ appearance: "light", reader: { vaultRoot: vault, currentPath: "引用.md" } }),
  );
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requests.push(Buffer.concat(parts).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "quoted-answer",
        object: "chat.completion",
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "已收到引用，保留来源与原文。" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地模型夹具未启动");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
  });
  context.onTestFinished(() => app.close());
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".document-body > .surface > .markdown-content").waitFor();
  await page.locator(".ProseMirror p").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page
    .locator(".ProseMirror p")
    .first()
    .evaluate((paragraph) => {
      paragraph.closest<HTMLElement>(".ProseMirror")?.focus();
      const selection = getSelection();
      selection?.selectAllChildren(paragraph);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const add = page.getByRole("button", { name: "将选中内容添加到 Agent", exact: true });
  await add.waitFor();
  await add.click();
  const composer = page.locator(".composer");
  await composer.getByRole("button", { name: "预览引用：引用.md", exact: true }).waitFor();
  const conversation = (await page.evaluate(() => window.noemori.agent.list())).items[0]!;
  expect(conversation.workspace).toBeNull();
  const prompt = page.getByRole("textbox", { name: "Agent 用户任务", exact: true });
  await prompt.fill("解释这两段引用");
  await page
    .locator(".ProseMirror p")
    .nth(1)
    .evaluate((paragraph) => {
      paragraph.closest<HTMLElement>(".ProseMirror")?.focus();
      getSelection()?.selectAllChildren(paragraph);
      document.dispatchEvent(new Event("selectionchange"));
    });
  await add.waitFor();
  await add.dragTo(composer);
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id))
          .draftReferences?.length,
    )
    .toBe(2);
  expect(await prompt.inputValue()).toBe("解释这两段引用");
  expect(await readFile(join(vault, "引用.md"), "utf8")).toBe(original);
  const catalog = await page.evaluate(
    (port) =>
      window.noemori.agent.providersSave({
        id: null,
        name: "引用模型",
        protocol: "openai-chat",
        address: { type: "endpoint", url: `http://127.0.0.1:${port}/v1/chat/completions` },
        authentication: { type: "none" },
        models: [
          {
            id: "fixture",
            tools: true,
            streaming: false,
            vision: false,
            audio: false,
            video: false,
          },
        ],
      }),
    address.port,
  );
  await page.evaluate(
    ({ id, provider }) =>
      window.noemori.agent.modelSelect(id, { providerId: provider, modelId: "fixture" }),
    { id: conversation.id, provider: catalog.providers[0]!.id },
  );
  await page.reload();
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await expect
    .poll(() => composer.getByRole("button", { name: "预览引用：引用.md", exact: true }).count())
    .toBe(2);
  expect(await prompt.inputValue()).toBe("解释这两段引用");
  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate((value) => window.noemori.app.appearanceSet(value), appearance);
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: appearance === "dark" ? "reduce" : "no-preference",
    });
    for (const [width, height] of [
      [1100, 720],
      [640, 480],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
        { width, height },
      );
      await composer
        .getByRole("button", { name: "预览引用：引用.md", exact: true })
        .first()
        .click();
      const preview = page.getByRole("dialog", { name: "引用预览", exact: true });
      await preview.waitFor();
      await expect
        .poll(() => preview.evaluate((element) => Number(getComputedStyle(element).opacity)))
        .toBe(1);
      expect(await preview.locator("blockquote").innerText()).toBe("第一段值得引用的文字😀。");
      const bounds = await preview.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      const captures = process.env["NOEMORI_REFERENCE_SCREENSHOTS"];
      if (captures) {
        await mkdir(captures, { recursive: true });
        await page.screenshot({
          path: join(captures, `reference-preview-${appearance}-${width}.png`),
          scale: "css",
        });
      }
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
    }
  }
  await composer.getByRole("button", { name: "预览引用：引用.md", exact: true }).first().click();
  await page.getByRole("button", { name: "跳回原文", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe("第一段值得引用的文字😀。");
  await prompt.fill("解释这两段引用");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).run
          ?.status,
      { timeout: 15000 },
    )
    .toBe("completed");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("第一段值得引用的文字😀。");
  expect(requests[0]).toContain("第二段也可以拖入对话。");
  expect(requests[0]).toContain("引用.md");
  expect(
    await composer.getByRole("button", { name: "预览引用：引用.md", exact: true }).count(),
  ).toBe(0);
  expect(await page.getByRole("article", { name: "你", exact: true }).innerText()).not.toContain(
    '"references"',
  );
  expect(await readFile(join(vault, "引用.md"), "utf8")).toBe(original);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720),
  );
  await noteAction(page, "切换源码视图");
  await page.locator(".cm-content").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await add.waitFor();
  await add.click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id))
          .draftReferences?.[0]?.text,
    )
    .toBe(original);
  expect(await readFile(join(vault, "引用.md"), "utf8")).toBe(original);
  expect(errors).toEqual([]);
});
