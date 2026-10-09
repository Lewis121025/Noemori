import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test.each(["light", "dark"])(
  "%s 模型菜单保持紧凑，滚动分组不遮挡选项，小窗口仍可搜索和调整强度",
  async (appearance) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-model-menu-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, "session.json"),
      JSON.stringify({ appearance, readingPalette: "green" }),
    );
    const executable: unknown = require("electron");
    if (typeof executable !== "string") throw new Error("Electron 未安装");
    const app = await electron.launch({
      executablePath: executable,
      colorScheme: null,
      args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${directory}`],
      cwd: fileURLToPath(desktop),
      env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
    });
    onTestFinished(() => app.close());
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => typeof window.noemori?.agent?.providersSave === "function");
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
      appearance === "dark",
    );
    await page.evaluate(async () => {
      const models = [
        "gpt-5.3",
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6-terra",
        "gpt-6.1-luna",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
      ];
      for (const [name, ids] of [
        ["自定义 / API 网关", models],
        ["另一个连接", ["a-very-long-model-identifier-to-check-ellipsis", "second-model"]],
      ] as const) {
        await window.noemori.agent.providersSave({
          id: null,
          name,
          protocol: "openai-chat",
          address: { type: "base_url", url: "https://example.com/v1" },
          authentication: { type: "none" },
          models: ids.map((id) => ({
            id,
            tools: true,
            streaming: false,
            vision: false,
            audio: false,
            video: false,
            reasoning: {
              supported: true,
              efforts: ["none", "low", "medium", "high", "xhigh", "max"],
            },
          })),
        });
      }
    });
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await page.getByRole("button", { name: "开始新对话", exact: true }).click();
    await page
      .getByRole("dialog", { name: "新建对话", exact: true })
      .getByRole("button", { name: "创建对话", exact: true })
      .click();
    const trigger = page.getByRole("button", { name: "选择对话模型", exact: true });
    await trigger.click();
    await page.getByRole("button", { name: "gpt-6-sol", exact: true }).click();
    const menu = page.getByRole("group", { name: "对话可用模型", exact: true });
    const captures = process.env["NOEMORI_UNIFIED_SCREENSHOTS"];
    if (captures) await mkdir(captures, { recursive: true });
    const input = page.getByRole("textbox", { name: "Agent 用户任务", exact: true });
    await input.fill("先整理一下这个想法");
    const conversation = (await page.evaluate(() => window.noemori.agent.list())).items[0]!;
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).draft,
      )
      .toBe("先整理一下这个想法");
    for (const [width, height] of [
      [1100, 720],
      [640, 480],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
        { width, height },
      );
      await page.waitForFunction(
        (size) => innerWidth === size.width && innerHeight === size.height,
        {
          width,
          height,
        },
      );
      const composer = page.locator(".composer");
      expect(await composer.getByRole("button", { name: "对话工具", exact: true }).count()).toBe(0);
      expect(await composer.innerText()).not.toContain("草稿已保存");
      const composerBounds = await composer.boundingBox();
      expect(composerBounds!.height).toBeLessThanOrEqual(128);
      expect(
        await composer.evaluate((element) => {
          const row = element.querySelector(".composer-actions")!.getBoundingClientRect();
          const controls = [
            ...element.querySelectorAll(
              ".composer-actions > button, .model-trigger, .reasoning-trigger",
            ),
          ].map((node) => node.getBoundingClientRect());
          const model = element.querySelector(".model-trigger")!.getBoundingClientRect();
          const effort = element.querySelector(".reasoning-trigger")!.getBoundingClientRect();
          return (
            controls.every(
              (box) =>
                box.left >= row.left &&
                box.right <= row.right &&
                Math.abs((box.top + box.bottom) / 2 - (row.top + row.bottom) / 2) < 1,
            ) && effort.left - model.right <= 8
          );
        }),
      ).toBe(true);
      if (captures)
        await composer.screenshot({
          path: join(captures, `composer-${appearance}-${width}.png`),
          animations: "disabled",
          scale: "css",
        });
      await trigger.click();
      await menu.waitFor();
      if (captures)
        await menu.screenshot({
          path: join(captures, `model-menu-${appearance}-${width}.png`),
          animations: "disabled",
          scale: "css",
        });
      if (captures && width === 640)
        await page.screenshot({
          path: join(captures, `model-window-${appearance}.png`),
          animations: "disabled",
          scale: "css",
        });
      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeLessThanOrEqual(304);
      expect(bounds!.height).toBeLessThanOrEqual(360);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      expect(
        await menu.evaluate((element) => {
          const headers = [...element.querySelectorAll(".provider-name")].map((node) =>
            node.getBoundingClientRect(),
          );
          return [...element.querySelectorAll(".model-option")]
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return headers.some((header) => box.top < header.bottom && box.bottom > header.top);
            })
            .map((node) => node.getAttribute("aria-label"));
        }),
      ).toEqual([]);
      await page.getByRole("searchbox", { name: "搜索模型", exact: true }).fill("second-model");
      expect(await menu.locator(".model-option").count()).toBe(1);
      await page.getByRole("searchbox", { name: "搜索模型", exact: true }).fill("no-match");
      await menu.getByText("没有匹配的模型", { exact: true }).waitFor();
      await page.getByRole("searchbox", { name: "搜索模型", exact: true }).fill("a-very-long");
      await page.keyboard.press("ArrowDown");
      const longModel = menu.getByRole("button", {
        name: "a-very-long-model-identifier-to-check-ellipsis",
        exact: true,
      });
      expect(await longModel.evaluate((node) => document.activeElement === node)).toBe(true);
      if (captures && width === 640)
        await menu.screenshot({
          path: join(captures, `model-search-${appearance}.png`),
          animations: "disabled",
          scale: "css",
        });
      await page.getByRole("searchbox", { name: "搜索模型", exact: true }).fill("");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
      const effortTrigger = page.getByRole("button", { name: "选择推理强度", exact: true });
      await effortTrigger.click();
      const efforts = page.getByRole("menu", { name: "对话推理强度", exact: true });
      expect(
        (await efforts.getByRole("menuitemradio").allTextContents()).map((text) => text.trim()),
      ).toEqual(["服务商默认", "none", "low", "medium", "high", "xhigh", "max"]);
      if (captures)
        await efforts.screenshot({
          path: join(captures, `reasoning-${appearance}-${width}.png`),
          animations: "disabled",
          scale: "css",
        });
      await efforts.getByRole("menuitemradio", { name: "high", exact: true }).click();
      await expect.poll(() => effortTrigger.textContent()).toContain("high");
      await efforts.waitFor({ state: "hidden" });
      await effortTrigger.click();
      await page.keyboard.press("Escape");
      await efforts.waitFor({ state: "hidden" });
      expect(await effortTrigger.evaluate((node) => document.activeElement === node)).toBe(true);
      await effortTrigger.click();
      await efforts.getByRole("menuitemradio", { name: "服务商默认", exact: true }).click();
      await efforts.waitFor({ state: "hidden" });
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id))
              .modelSelection,
        )
        .toEqual({ providerId: conversation.modelSelection!.providerId, modelId: "gpt-6-sol" });
    }
    await input.fill("第一行\n第二行\n第三行\n第四行\n第五行");
    const expanded = await input.boundingBox();
    expect(expanded!.height).toBeGreaterThan(44);
    expect(expanded!.height).toBeLessThanOrEqual(160);
    await page.getByRole("button", { name: "对话操作", exact: true }).click();
    await page.getByRole("button", { name: "查看会话终端", exact: true }).click();
    await page.getByRole("region", { name: "会话终端", exact: true }).waitFor();
    await page.getByRole("button", { name: "收起终端", exact: true }).click();
    await page.getByRole("button", { name: "对话操作", exact: true }).click();
    await page.getByRole("button", { name: "浏览器连接与权限…", exact: true }).click();
    const connections = page.getByRole("region", { name: "浏览器与应用控制", exact: true });
    await connections
      .getByRole("button", { name: "设置 Chrome / Edge 连接", exact: true })
      .waitFor();
    expect(
      await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id),
    ).toMatchObject({
      terminals: [],
      run: null,
      ui: { status: "idle", connections: [] },
    });
  },
);
