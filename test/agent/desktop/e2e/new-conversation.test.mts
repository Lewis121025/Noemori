import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { newConversation } from "../../../notes/desktop/support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("新建无需目录，选择关联可取消，独立对话与分叉可跨进程继续", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-optional-directory-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const linked = join(directory, "linked"),
    state = join(directory, "state");
  await Promise.all([mkdir(linked), mkdir(state)]);
  let calls = 0;
  const server = createServer(async (input, output) => {
    for await (const _piece of input) {
      /* 完整读取请求后再返回模型响应。 */
    }
    calls += 1;
    output.writeHead(200, { "content-type": "application/json" });
    output.end(
      JSON.stringify({
        id: `response-${calls}`,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "独立讨论已完成" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("测试模型未启动");
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
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  await page.evaluate(
    (endpoint) =>
      window.noemori.agent.providersSave({
        id: null,
        name: "测试连接",
        protocol: "openai-chat",
        address: { type: "endpoint", url: endpoint },
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
    `http://127.0.0.1:${address.port}/model`,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "开始新对话", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新建对话", exact: true });
  expect(await creation.getByRole("combobox").count()).toBe(0);
  expect(await creation.getByRole("button", { name: "创建对话", exact: true }).isEnabled()).toBe(
    true,
  );
  await creation.getByRole("textbox", { name: "会话名称", exact: true }).fill("独立讨论");
  await creation.getByRole("button", { name: "关联文件夹…", exact: true }).click();
  await expect
    .poll(() => creation.getByRole("button", { name: "创建对话", exact: true }).isEnabled())
    .toBe(true);
  const captures = process.env["NOEMORI_UNIFIED_SCREENSHOTS"];
  if (captures) {
    await mkdir(captures, { recursive: true });
    await creation.screenshot({
      path: join(captures, "new-conversation.png"),
      animations: "disabled",
    });
  }
  await creation.getByRole("button", { name: "创建对话", exact: true }).click();
  const independent = (await page.evaluate(() => window.noemori.agent.list())).items[0]!;
  expect(independent.workspace).toBeNull();
  expect(independent.article).toBeNull();
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "fixture", exact: true }).click();
  await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).fill("开始独立讨论");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), independent.id)).run
          ?.status,
    )
    .toBe("completed");
  expect(calls).toBe(1);
  const fork = await page.evaluate(
    (id) => window.noemori.agent.fork(id, { title: "独立分支", afterTurnId: null }),
    independent.id,
  );
  expect(fork.workspace).toBeNull();
  await page.evaluate((id) => window.noemori.agent.start(id, "继续分支"), fork.id);
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), fork.id)).run?.status,
    )
    .toBe("completed");
  expect(calls).toBe(2);
  await app.evaluate(({ dialog }, linked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [linked] });
  }, linked);
  await newConversation(page);
  await creation.getByRole("textbox", { name: "会话名称", exact: true }).fill("关联讨论");
  await creation.getByRole("button", { name: "关联文件夹…", exact: true }).click();
  await creation.getByRole("button", { name: "取消目录关联", exact: true }).waitFor();
  await creation.getByRole("button", { name: "创建对话", exact: true }).click();
  await page.getByRole("heading", { name: "关联讨论", exact: true }).waitFor();
  expect(
    (await page.evaluate(() => window.noemori.agent.list())).items.find(
      (item) => item.title === "关联讨论",
    )?.workspace,
  ).toMatch(/\/linked$/u);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  expect(
    (await page.evaluate((id) => window.noemori.agent.snapshot(id), independent.id)).workspace,
  ).toBeNull();
  await page.evaluate((id) => window.noemori.agent.start(id, "重启后继续"), fork.id);
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), fork.id)).run?.status,
    )
    .toBe("completed");
  expect(calls).toBe(3);
});
