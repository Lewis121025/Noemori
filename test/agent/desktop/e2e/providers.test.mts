import { newConversation, openSettings } from "../../../notes/desktop/support/workspace-actions";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron, type Page } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("LLM 配置位于统一设置，首次表单简洁且窄窗口没有水平溢出", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-provider-layout-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "session.json"),
    JSON.stringify({ appearance: "dark", readingPalette: "green" }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${root}`],
    env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
  });
  context.onTestFinished(() => app.close());
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "LLM", exact: true })
    .click();
  const config = page.getByRole("region", { name: "供应商配置管理", exact: true });
  await config.getByRole("combobox", { name: "供应商预设", exact: true }).waitFor();
  expect(await config.locator("aside, .default-model, .provider-layout").count()).toBe(0);
  expect(await config.getByRole("textbox", { name: "搜索供应商" }).count()).toBe(0);
  expect(await config.getByRole("button", { name: /添加供应商/ }).count()).toBe(0);
  expect(await config.getByRole("button", { name: "保存供应商", exact: true }).isDisabled()).toBe(
    true,
  );
  expect(await config.getByRole("combobox", { name: "模型 1", exact: true }).count()).toBe(0);
  expect(await page.locator(".agent-panel .panel-error").count()).toBe(0);
  expect(await page.getByRole("dialog", { name: "设置", exact: true }).isVisible()).toBe(true);
  expect(await page.locator(".agent-panel .model-settings").count()).toBe(0);
  const captures = process.env["NOEMORI_UNIFIED_SCREENSHOTS"];
  if (captures) {
    await mkdir(captures, { recursive: true });
    await page
      .locator(".settings-window")
      .screenshot({ path: join(captures, "llm-settings.png"), animations: "disabled" });
  }
  for (const width of [640, 1100]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720),
      width,
    );
    await page.waitForFunction((width) => innerWidth === width, width);
    expect(
      await config.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("input, select, button")].every((control) => {
          const box = control.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      }),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "开始新对话", exact: true }).waitFor();
});

async function addProvider(
  page: Page,
  name: string,
  base: string,
  model: string,
  protocol: "openai-chat" | "anthropic" = "openai-chat",
): Promise<void> {
  await page.getByRole("button", { name: "保存供应商", exact: true }).waitFor();
  if (await page.getByRole("combobox", { name: "已保存供应商", exact: true }).isVisible())
    await page.getByRole("button", { name: "＋ 添加供应商", exact: true }).click();
  await page.getByRole("combobox", { name: "供应商预设", exact: true }).selectOption("custom");
  await page.getByRole("textbox", { name: "接口地址", exact: true }).fill(base);
  await page.getByRole("button", { name: "高级设置", exact: true }).click();
  await page.getByRole("combobox", { name: "协议", exact: true }).selectOption(protocol);
  await page.getByRole("textbox", { name: "名称", exact: true }).fill(name);
  await page.getByRole("combobox", { name: "请求认证", exact: true }).selectOption("none");
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  await page.getByText("连接已保存，模型可在对话中选择。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "高级设置", exact: true }).click();
  await expect
    .poll(async () => page.getByRole("textbox", { name: "模型标识 1", exact: true }).inputValue())
    .toBe(model);
  expect(await page.getByRole("combobox", { name: "图像能力 1", exact: true }).inputValue()).toBe("");
  await page.getByRole("checkbox", { name: "流式输出", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  await page.getByText("供应商已保存。", { exact: true }).waitFor();
  const catalog = await page.evaluate(() => window.noemori.agent.providersGet());
  expect(catalog.providers.find((provider) => provider.name === name)?.models[0]?.vision).toBeNull();
}

test("真实窗口按对话切换模型与强度，当前轮不变、其他对话独立，重启后保留选择", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-provider-desktop-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  const requests: { path: string | undefined; body: string }[] = [];
  const firstResponse: { finish: (() => void) | null } = { finish: null };
  const server = createServer(async (input, output) => {
    if (input.method === "GET" && input.url?.endsWith("/models")) {
      output.writeHead(200, { "content-type": "application/json" });
      output.end(
        JSON.stringify({
          data: [
            input.url.startsWith("/old/")
              ? { id: "old-model" }
              : {
                  id: "new-model",
                  capabilities: {
                    thinking: { supported: true },
                    effort: { supported: true, high: { supported: true } },
                  },
                },
          ],
          has_more: false,
        }),
      );
      return;
    }
    let body = "";
    for await (const piece of input) body += piece.toString();
    requests.push({ path: input.url, body });
    const finish = (): void => {
      output.writeHead(200, { "content-type": "application/json" });
      output.end(
        JSON.stringify(
          input.url === "/new/messages"
            ? {
                id: `response-${requests.length}`,
                role: "assistant",
                content: [{ type: "text", text: "已记住计划" }],
                stop_reason: "end_turn",
                usage: {},
              }
            : {
                id: `response-${requests.length}`,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "已记住计划" },
                    finish_reason: "stop",
                  },
                ],
              },
        ),
      );
    };
    if (requests.length === 1) firstResponse.finish = finish;
    else finish();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
      cwd: fileURLToPath(desktop),
      env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
    });
  let app = await launch();
  context.onTestFinished(() => app.close());
  let page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "LLM", exact: true })
    .click();
  await addProvider(page, "原有服务", `http://127.0.0.1:${address.port}/old`, "old-model");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await newConversation(page);
  const creation = page.getByRole("dialog", { name: "新建对话", exact: true });
  await creation.getByRole("textbox", { name: "会话名称", exact: true }).fill("历史会话");
  await creation.getByRole("button", { name: /^(?:更换)?关联文件夹…$/ }).click();
  await creation.getByRole("button", { name: "创建对话", exact: true }).click();
  const conversation = (await page.evaluate(() => window.noemori.agent.list())).items[0]!;
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "old-model", exact: true }).click();
  const other = await page.evaluate(async () => {
    const item = await window.noemori.agent.create(null, "另一个对话");
    const provider = (await window.noemori.agent.providersGet()).providers[0]!;
    await window.noemori.agent.modelSelect(item.id, {
      providerId: provider.id,
      modelId: "old-model",
    });
    return item.id;
  });
  await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).fill("记住项目计划");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "连接设置", exact: true }).click();
  expect(await page.getByRole("dialog", { name: "设置", exact: true }).isVisible()).toBe(true);
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "LLM", exact: true })
    .click();
  await addProvider(
    page,
    "新服务",
    `http://127.0.0.1:${address.port}/new`,
    "new-model",
    "anthropic",
  );
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "new-model", exact: true }).click();
  await page.getByRole("button", { name: "选择推理强度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id))
          .modelSelection?.reasoningEffort,
    )
    .toBe("high");
  expect(
    (await page.evaluate((id) => window.noemori.agent.snapshot(id), other)).modelSelection?.modelId,
  ).toBe("old-model");
  const captures = process.env["NOEMORI_UNIFIED_SCREENSHOTS"];
  if (captures) {
    await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
    await page
      .locator(".agent-panel")
      .screenshot({ path: join(captures, "conversation-models.png"), animations: "disabled" });
    await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  }
  const running = await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id);
  expect(running.run?.status).toBe("running");
  expect(running.model).toBe("old-model");
  if (!firstResponse.finish) throw new Error("旧请求没有等待完成");
  firstResponse.finish();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).run
          ?.status,
    )
    .toBe("completed");
  await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).fill("继续项目计划");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]?.path).toBe("/old/chat/completions");
  expect(requests[1]?.path).toBe("/new/messages");
  expect(JSON.parse(requests[1]!.body).output_config.effort).toBe("high");
  expect(JSON.parse(requests[1]!.body).model).toBe("new-model");
  expect(requests[1]!.body).toContain("记住项目计划");
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), conversation.id)).run
          ?.status,
    )
    .toBe("completed");
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  expect(
    (await page.evaluate((id) => window.noemori.agent.snapshot(id), other)).modelSelection?.modelId,
  ).toBe("old-model");
  await page.evaluate((id) => window.noemori.agent.start(id, "重启后继续"), conversation.id);
  await expect.poll(() => requests.length).toBe(3);
  expect(JSON.parse(requests[2]!.body).model).toBe("new-model");
  expect(JSON.parse(requests[2]!.body).output_config.effort).toBe("high");
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "LLM", exact: true })
    .click();
  await page.getByRole("button", { name: "高级设置", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("尚未保存的供应商修改");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await page.getByText("当前修改尚未保存，是否放弃？", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  expect(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue()).toBe(
    "尚未保存的供应商修改",
  );
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  const longRun = await page.evaluate(
    async ({ id, port }) => {
      const catalog = await window.noemori.agent.providersSave({
        id: null,
        name: "编码预算边界",
        protocol: "gemini",
        address: { type: "base_url", url: `http://127.0.0.1:${port}/${"路".repeat(7000)}` },
        authentication: { type: "none" },
        models: [
          {
            id: "模".repeat(7000),
            tools: true,
            streaming: false,
            vision: false,
            audio: false,
            video: false,
          },
        ],
      });
      const provider = catalog.providers.at(-1);
      if (!provider) throw new Error("保存结果缺失");
      await window.noemori.agent.modelSelect(id, {
        providerId: provider.id,
        modelId: provider.models[0].id,
      });
      const settings = await window.noemori.agent.settingsGet(id);
      if (!settings || new TextEncoder().encode(JSON.stringify(settings)).length <= 128 * 1024)
        throw new Error("未覆盖 UTF-8 编码后的配置预算");
      return window.noemori.agent.start(id, "验证本轮配置入口的字节预算");
    },
    { id: conversation.id, port: address.port },
  );
  await page.evaluate(({ id, run }) => window.noemori.agent.cancel(id, run), {
    id: conversation.id,
    run: longRun,
  });
  expect(errors).toEqual([]);
});
