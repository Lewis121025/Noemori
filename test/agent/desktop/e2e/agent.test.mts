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

async function createConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "选择文件夹…", exact: true }).click();
  await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
  await page.getByRole("textbox", { name: "Agent 用户任务" }).waitFor();
}

async function current(page: Page) {
  return page.evaluate(async () => {
    const item = (await window.noemori.agent.list()).items[0];
    return item ? window.noemori.agent.snapshot(item.id) : null;
  });
}

function launch(state: string) {
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  return electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    cwd: fileURLToPath(desktop),
    env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
  });
}

async function configure(page: Page, endpoint: string): Promise<void> {
  page.setDefaultTimeout(8000);
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  await page.evaluate(async (endpoint) => {
    await window.noemori.agent.providersSave({
      protocol: "openai-chat",
      id: null,
    name: "测试供应商",
      address: { type: "endpoint", url: endpoint },
      authentication: { type: "none" },
      models: [{ id: "fixture", tools: true,
      streaming: false,
      vision: false,
      audio: false,
      video: false }],
    });
  }, endpoint);
}

async function deleteConversation(page: Page): Promise<void> {
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "删除对话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除对话", exact: true })
    .getByRole("button", { name: "删除对话", exact: true })
    .click();
  await expect
    .poll(async () => (await page.evaluate(() => window.noemori.agent.list())).items.length)
    .toBe(0);
}

test("实际窗口审批、终端输入与渲染器重载使用同一原生会话", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-desktop-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  const secret = join(root, "secret");
  await writeFile(secret, "fixture-secret");
  let calls = 0;
  const server = createServer(async (input, output) => {
    for await (const _piece of input) {
      /* 请求读取完再交付完整协议响应。 */
    }
    calls += 1;
    const message =
      calls === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "interactive",
                type: "function",
                function: {
                  name: "terminal",
                  arguments: JSON.stringify({
                    action: "exec",
                    cmd: `printf ready; read value; printf 'received:%s\n' "$value"; sleep 30`,
                    tty: true,
                    yield_time_ms: 0,
                    permission_request: { reason: "读取外部测试文件", readable_paths: [secret] },
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "终端已就绪" };
    output.writeHead(200, { "content-type": "application/json" });
    output.end(
      JSON.stringify({
        id: `desktop-${calls}`,
        choices: [{ index: 0, message, finish_reason: calls === 1 ? "tool_calls" : "stop" }],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  const app = await launch(state);
  const page = await app.firstWindow();
  await configure(page, `http://127.0.0.1:${address.port}/chat`);
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await createConversation(page, "终端验收");
  await page.getByRole("textbox", { name: "Agent 用户任务" }).fill("打开终端");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".approval").waitFor();
  expect(await page.locator(".approval").textContent()).toContain("读取外部测试文件");
  await page.getByRole("button", { name: "批准本次", exact: true }).click();
  await expect
    .poll(
      async () => {
        const item = await current(page);
        return item?.run?.status === "completed" && item.terminals[0]!.bytes > 0;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const before = (await current(page))!.id;
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.locator(".terminal-screen").click();
  await page.keyboard.type("line");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const info = (await window.noemori.agent.list()).items[0]!;
          const item = await window.noemori.agent.snapshot(info.id);
          const terminal = item.terminals[0];
          if (!terminal) return false;
          const result = await window.noemori.agent.terminalRead(
            item.id,
            terminal.process.session_id,
            "0",
          );
          return result.chunks.some((chunk) => atob(chunk.data_base64).includes("received:line"));
        }),
      { timeout: 15000 },
    )
    .toBe(true);
  await page.reload();
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  expect(await current(page)).toMatchObject({ id: before, terminals: [{ tty: true }] });
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await current(page))?.terminals.every((terminal) => terminal.process.status !== "running"),
      { timeout: 15000 },
    )
    .toBe(true);
  await deleteConversation(page);
  await app.close();
});

test("真实原生对话跨进程保留上下文和草稿，归档恢复后继续且不会自动发起模型请求", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-restart-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "项目"),
    state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  const requests: string[] = [];
  const server = createServer(async (input, output) => {
    let body = "";
    for await (const chunk of input) body += chunk;
    requests.push(body);
    const answer =
      requests.length === 1 ? "记住了，项目代号是青禾。" : "继续青禾项目，先整理需求。";
    output.writeHead(200, { "content-type": "application/json" });
    output.end(
      JSON.stringify({
        id: `restart-${requests.length}`,
        choices: [
          { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
        ],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  let app = await launch(state);
  let page = await app.firstWindow();
  await configure(page, `http://127.0.0.1:${address.port}/chat`);
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await createConversation(page, "青禾规划");
  const prompt = page.getByRole("textbox", { name: "Agent 用户任务" });
  await prompt.fill("记住项目代号：青禾");
  await prompt.press("Enter");
  await expect.poll(async () => (await current(page))?.run?.status).toBe("completed");
  await expect
    .poll(() => page.getByRole("log", { name: "对话消息" }).innerText())
    .toContain("记住了，项目代号是青禾。");
  await prompt.fill("请继续这个项目");
  await page.getByRole("button", { name: "关闭助手", exact: true }).click();
  const id = (await current(page))!.id;
  await app.close();
  app = await launch(state);
  page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  const restoredPrompt = page.getByRole("textbox", { name: "Agent 用户任务" });
  await expect.poll(() => restoredPrompt.inputValue()).toBe("请继续这个项目");
  expect((await current(page))!.id).toBe(id);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "归档对话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "归档对话", exact: true })
    .getByRole("button", { name: "归档对话", exact: true })
    .click();
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await page.locator(".conversation-item").click();
  await page.getByRole("button", { name: "恢复对话", exact: true }).click();
  await restoredPrompt.waitFor();
  expect(requests).toHaveLength(1);
  await restoredPrompt.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toContain("记住项目代号：青禾");
  expect(requests[1]).toContain("记住了，项目代号是青禾。");
  await expect
    .poll(() => page.getByRole("log", { name: "对话消息" }).innerText())
    .toContain("继续青禾项目");
  await deleteConversation(page);
  await app.close();
});
