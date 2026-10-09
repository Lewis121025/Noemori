import { newConversation, openLibrary } from "../../../notes/desktop/support/workspace-actions";
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

test("真实窗口支持建议草稿、消息复制、历史滚动、固定审批和失败后继续", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-polish-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  const reference = join(root, "reference.txt");
  await writeFile(reference, "用于验收的参考资料");
  const code = "function nextStep() {\n  return '开始';\n}";
  const answer = [
    "## 下一步计划", "", "| 方案 | 优点 |", "| --- | --- |", "| 提纲 | 梳理思路 |", "",
    "- [x] 整理资料", "- [ ] 验证想法", "", "```typescript", code, "```", "",
    ...Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 个检查点：先确认目标和资料来源，再用实际结果决定下一步。\n`),
  ].join("\n");
  let mode: "reply" | "approval" | "failure" = "reply";
  let requests = 0;
  const server = createServer(async (input, output) => {
    let raw = "";
    for await (const piece of input) raw += piece;
    requests += 1;
    if (mode === "failure") {
      output.writeHead(400, { "content-type": "application/json" });
      output.end(JSON.stringify({ error: { message: "测试模型暂时不可用" } }));
      return;
    }
    const body: { messages: { role: string }[] } = JSON.parse(raw);
    const tool = mode === "approval" && body.messages.at(-1)?.role === "user";
    output.writeHead(200, { "content-type": "application/json" });
    output.end(JSON.stringify({
      id: `polish-${requests}`,
      choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: tool
        ? { role: "assistant", content: "我会先核对资料。", tool_calls: [{
            id: `read-${requests}`, type: "function", function: { name: "terminal", arguments: JSON.stringify({
              action: "exec", cmd: `cat '${reference}'`,
              permission_request: { reason: "核对参考资料", readable_paths: [reference] },
            }) },
          }] }
        : { role: "assistant", content: answer },
      }],
    }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("测试模型未监听");
  const app = await launch(state);
  const page = await app.firstWindow();
  await configure(page, `http://127.0.0.1:${address.port}/chat`);
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await createConversation(page, "体验验收");
  const composer = page.getByRole("textbox", { name: "Agent 用户任务", exact: true });
  await page.getByRole("button", { name: "整理思路", exact: true }).click();
  expect(await composer.inputValue()).toContain("请先问我想讨论的主题");
  expect(await composer.evaluate((node) => node === document.activeElement)).toBe(true);
  expect(requests).toBe(0);
  await composer.fill("");
  const sendButton = page.getByRole("button", { name: "发送", exact: true });
  await expect.poll(() => sendButton.isDisabled()).toBe(true);
  const disabledFill = await sendButton.evaluate((node) => getComputedStyle(node).backgroundColor);
  await composer.fill("制定计划");
  await expect.poll(() => sendButton.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(disabledFill);
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "删除对话", exact: true }).click();
  const deletion = page.getByRole("dialog", { name: "删除对话", exact: true });
  await expect.poll(() => deletion.getByRole("button", { name: "删除对话", exact: true })
    .evaluate((node) => {
      const [red, green] = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)!.map(Number);
      return red! > green!;
    })).toBe(true);
  await deletion.getByRole("button", { name: "取消", exact: true }).click();
  await composer.press("Shift+Enter");
  expect(await composer.inputValue()).toBe("制定计划\n");
  expect(requests).toBe(0);
  await expect.poll(() => page.getByRole("button", { name: "发送", exact: true }).isEnabled()).toBe(true);
  await composer.press("Enter");
  await expect.poll(async () => (await current(page))?.run?.status, { timeout: 10000 }).toBe("completed");
  expect(await page.locator(".messages thead th").allTextContents()).toEqual(["方案", "优点"]);
  expect(await page.locator('.messages input[type="checkbox"]').first().isChecked()).toBe(true);
  await page.getByRole("button", { name: "复制代码", exact: true }).click();
  await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);
  await page.locator('article[aria-label="助手"]').getByRole("button", { name: "复制消息", exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
  await composer.focus();
  await page.locator(".conversation-header").hover();
  await expect.poll(() => page.locator('article[aria-label="助手"] .message-actions').getByRole("button", { name: "已复制", exact: true })
    .evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  const messages = page.locator(".messages");
  await messages.hover();
  await page.mouse.wheel(0, -1600);
  await page.getByRole("button", { name: "↓ 回到最新消息", exact: true }).waitFor();
  const position = await messages.evaluate((node) => node.scrollTop);
  mode = "approval";
  await composer.fill("核对资料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".approval").waitFor();
  expect(await page.locator(".approval").evaluate((node) => node.closest('[role="log"]') === null)).toBe(true);
  expect(await page.locator(".run-status").textContent()).toContain("等待你的确认");
  expect(await messages.evaluate((node) => node.scrollTop)).toBeGreaterThan(position);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await composer.fill(Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 项待讨论内容`).join("\n"));
  await expect.poll(() => messages.evaluate((node) => node.clientHeight)).toBeGreaterThan(48);
  expect(await page.locator(".composer").evaluate((node) => node.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await composer.fill("追加一项检查");
  await page.getByRole("button", { name: "排队追问", exact: true }).click();
  await page.getByRole("button", { name: "暂停队列", exact: true }).click();
  await page.getByRole("button", { name: "继续队列", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(640, 480));
  await composer.fill(Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 项待讨论内容`).join("\n"));
  await expect.poll(() => page.evaluate(() => {
    const approval = document.querySelector(".approval")!.getBoundingClientRect();
    const queue = document.querySelector(".queue")!.getBoundingClientRect();
    const composer = document.querySelector(".composer")!.getBoundingClientRect();
    const actions = document.querySelector(".approval-actions")!.getBoundingClientRect();
    return approval.bottom <= queue.top && queue.bottom <= composer.top &&
      actions.top >= approval.top && actions.bottom <= approval.bottom;
  })).toBe(true);
  await page.getByRole("button", { name: "移除追问", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
  await messages.hover();
  await page.mouse.wheel(0, -1600);
  await page.getByRole("button", { name: "↓ 回到最新消息", exact: true }).waitFor();
  expect(await page.locator(".approval").isVisible()).toBe(true);
  await page.getByRole("button", { name: "批准本次", exact: true }).click();
  await expect.poll(async () => (await current(page))?.run?.status).toBe("completed");
  expect(await page.locator(".tool-state").textContent()).toBe("已完成");
  await page.locator(".tool-call > summary").click();
  await page.getByRole("button", { name: "复制输出", exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("用于验收的参考资料");
  await page.getByRole("button", { name: "↓ 回到最新消息", exact: true }).click();
  mode = "failure";
  await composer.fill("模拟模型失败");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await current(page))?.run?.status).toBe("failed");
  await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
  mode = "reply";
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect.poll(async () => (await current(page))?.run?.status).toBe("completed");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  expect(await page.locator(".composer").evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  })).toBe(true);
  expect(await messages.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await app.close();
});

async function createConversation(page: Page, title: string, linked = true): Promise<void> {
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await newConversation(page);
  const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(title);
  if (linked) await dialog.getByRole("button", { name: /^(?:更换)?关联文件夹…$/u }).click();
  await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
  await page.getByRole("textbox", { name: "Agent 用户任务" }).waitFor();
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "fixture", exact: true }).click();
  await expect.poll(async () => (await current(page))?.modelSelection?.modelId).toBe("fixture");
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

async function configure(
  page: Page,
  endpoint: string,
  streaming = false,
  protocol: "openai-chat" | "openai-responses" = "openai-chat",
): Promise<void> {
  page.setDefaultTimeout(8000);
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
  await page.evaluate(async ({ endpoint, streaming, protocol }) => {
    await window.noemori.agent.providersSave({
      protocol,
      id: null,
    name: "测试供应商",
      address: { type: "endpoint", url: endpoint },
      authentication: { type: "none" },
      models: [{ id: "fixture", tools: true,
      streaming,
      vision: false,
      audio: false,
      video: false }],
    });
  }, { endpoint, streaming, protocol });
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

for (const protocol of ["openai-chat", "openai-responses"] as const) {
  test(`${protocol} 请求流式但收到完整 JSON 时，独立对话连续两轮正常完成`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "noemori-agent-json-stream-"));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const requests: string[] = [];
    const server = createServer(async (input, output) => {
      let body = "";
      for await (const chunk of input) body += chunk;
      requests.push(body);
      const text = `第 ${requests.length} 轮完成`;
      const response =
        protocol === "openai-chat"
          ? {
              choices: [
                { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
              ],
            }
          : {
              status: "completed",
              output: [
                { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
              ],
            };
      output.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      output.end(JSON.stringify(response));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
    const app = await launch(join(root, "state"));
    const page = await app.firstWindow();
    try {
      await configure(page, `http://127.0.0.1:${address.port}/model`, true, protocol);
      await createConversation(page, "响应格式验收", false);
      for (let turn = 1; turn <= 2; turn += 1) {
        await page.getByRole("textbox", { name: "Agent 用户任务" }).fill(`测试第 ${turn} 轮`);
        await expect
          .poll(() => page.getByRole("button", { name: "发送", exact: true }).isEnabled())
          .toBe(true);
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect
          .poll(() => page.getByRole("log", { name: "对话消息" }).innerText(), { timeout: 15000 })
          .toContain(`第 ${turn} 轮完成`);
        await expect.poll(async () => (await current(page))?.run?.status).toBe("completed");
      }
      expect(requests).toHaveLength(2);
      for (const body of requests) {
        expect(JSON.parse(body)).toMatchObject({ stream: true, model: "fixture" });
      }
      expect(requests[1]).toContain("第 1 轮完成");
      expect(await page.getByText("本次任务未完成", { exact: true }).count()).toBe(0);
    } finally {
      await app.close();
    }
  });
}

test("部分流式回答失败后手动继续保留上下文和独立草稿，重复点击只发起一轮", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-manual-recovery-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const server = createServer(async (input, output) => {
    let body = "";
    for await (const chunk of input) body += chunk;
    requests.push(body);
    if (requests.length === 1) {
      output.writeHead(200, { "content-type": "text/event-stream" });
      output.end(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "已输出部分回答" }, finish_reason: null }],
      })}\n\n`);
    } else {
      output.writeHead(200, { "content-type": "application/json" });
      output.end(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "任务已继续" }, finish_reason: "stop" }],
      }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  const app = await launch(join(root, "state"));
  const page = await app.firstWindow();
  try {
    await configure(page, `http://127.0.0.1:${address.port}/model`, true);
    await createConversation(page, "手动继续验收", false);
    const prompt = page.getByRole("textbox", { name: "Agent 用户任务" });
    await prompt.fill("请解释两个要点");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => (await current(page))?.run?.status, { timeout: 15000 }).toBe("failed");
    expect(requests).toHaveLength(1);
    await prompt.fill("暂不发送的独立草稿");
    await page.getByRole("button", { name: "继续任务", exact: true }).click({ clickCount: 2 });
    await expect.poll(async () => (await current(page))?.run?.status, { timeout: 15000 }).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("请解释两个要点");
    expect(requests[1]).toContain("已输出部分回答");
    expect(requests[1]).not.toContain("暂不发送的独立草稿");
    expect(await prompt.inputValue()).toBe("暂不发送的独立草稿");
    expect((await current(page))?.draft).toBe("暂不发送的独立草稿");
  } finally {
    await app.close();
  }
});

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
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "查看会话终端", exact: true }).click();
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
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "查看会话终端", exact: true }).click();
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
  await page.getByText("此对话已归档", { exact: true }).waitFor();
  await page.getByRole("button", { name: "恢复对话", exact: true }).click();
  await restoredPrompt.waitFor();
  expect(requests).toHaveLength(1);
  await restoredPrompt.press("Enter");
  await expect.poll(() => requests.length, { timeout: 15000 }).toBe(2);
  expect(requests[1]).toContain("记住项目代号：青禾");
  expect(requests[1]).toContain("记住了，项目代号是青禾。");
  await expect
    .poll(() => page.getByRole("log", { name: "对话消息" }).innerText())
    .toContain("继续青禾项目");
  await deleteConversation(page);
  await app.close();
});

test("运行中补充保持同轮，追问按序派发，中断暂停队列且后台终端可继续使用", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-steer-queue-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const releases = new Map<number, () => void>();
  const server = createServer(async (input, output) => {
    let body = "";
    for await (const chunk of input) body += chunk;
    requests.push(body);
    const call = requests.length;
    const finish = () => {
      output.writeHead(200, { "content-type": "application/json" });
      output.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: `请求 ${call} 已完成` }, finish_reason: "stop" }] }));
    };
    if (call === 1 || call === 3) releases.set(call, finish);
    else finish();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  const app = await launch(join(root, "state"));
  const page = await app.firstWindow();
  try {
    await configure(page, `http://127.0.0.1:${address.port}/chat`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 900));
    await createConversation(page, "继续与终端验收", false);
    const prompt = page.getByRole("textbox", { name: "Agent 用户任务" });
    await prompt.fill("原任务");
    await prompt.press("Enter");
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(1);
    const original = (await current(page))!.run!.id;
    await prompt.fill("补充当前任务的约束");
    await prompt.press("Control+Enter");
    await expect.poll(() => prompt.inputValue()).toBe("");
    expect((await current(page))!.run!.id).toBe(original);
    expect((await current(page))!.turns).toHaveLength(1);
    await prompt.fill("第一条排队追问");
    await prompt.press("Enter");
    await expect.poll(() => prompt.inputValue()).toBe("");
    await prompt.fill("第二条排队追问");
    await prompt.press("Enter");
    await expect.poll(() => prompt.inputValue()).toBe("");
    await prompt.fill("保留未发送的独立草稿");
    expect(await page.getByRole("region", { name: "追问队列" }).innerText()).toContain("第二条排队追问");

    await page.getByRole("button", { name: "对话操作", exact: true }).click();
    await page.getByRole("button", { name: "查看会话终端", exact: true }).click();
    await page.getByRole("button", { name: "打开终端", exact: true }).click();
    const screen = page.locator(".terminal-screen");
    await screen.waitFor();
    await screen.click();
    await page.keyboard.type("printf 'terminal-%s\\n' alive");
    await page.keyboard.press("Enter");
    await expect.poll(() => screen.innerText()).toContain("terminal-alive");
    const terminalId = (await current(page))!.terminals.at(-1)!.process.session_id;
    const drawer = page.getByRole("region", { name: "会话终端" });
    const previousHeight = (await drawer.boundingBox())!.height;
    await page.getByRole("button", { name: "调整终端高度", exact: true }).focus();
    await page.keyboard.press("ArrowUp");
    expect((await drawer.boundingBox())!.height).toBeGreaterThan(previousHeight);
    const artifacts = process.env.NOEMORI_AGENT_CONTINUATION_SCREENSHOTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(theme === "dark");
        await expect.poll(() => screen.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(theme === "dark" ? "rgb(30, 36, 31)" : "rgb(246, 248, 243)");
        await page.locator(".agent-panel").screenshot({ path: join(artifacts, `agent-continuation-terminal-${theme}.png`) });
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 600));
    await page.waitForFunction(() => innerWidth === 900 && innerHeight === 600);
    expect((await page.getByRole("log", { name: "对话消息" }).boundingBox())!.height).toBeGreaterThanOrEqual(80);
    expect((await screen.boundingBox())!.height).toBeGreaterThan(40);
    expect(await drawer.evaluate((node) => node.scrollHeight <= node.clientHeight + 2)).toBe(true);
    const composer = await page.locator(".composer").boundingBox();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    if (artifacts) await page.locator(".agent-panel").screenshot({ path: join(artifacts, "agent-continuation-terminal-small.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480));
    await page.waitForFunction(() => innerWidth === 640 && innerHeight === 480);
    expect((await screen.boundingBox())!.height).toBeGreaterThan(25);
    expect((await page.getByRole("log", { name: "对话消息" }).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    if (artifacts) await page.locator(".agent-panel").screenshot({ path: join(artifacts, "agent-continuation-terminal-minimum.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 900));
    await page.getByRole("button", { name: "收起终端", exact: true }).click();
    expect((await current(page))!.terminals.at(-1)!.process.status).toBe("running");

    releases.get(1)!();
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(3);
    expect(requests[1]).toContain("补充当前任务的约束");
    expect(requests[2]).toContain("第一条排队追问");
    expect((await current(page))!.turns).toHaveLength(2);
    await page.getByRole("button", { name: "停止生成", exact: true }).click();
    await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
    const id = (await current(page))!.id;
    expect(await page.evaluate((id) => window.noemori.agent.queueGet(id), id)).toMatchObject({ paused: true, messages: [{ text: "第二条排队追问" }] });
    expect((await current(page))!.terminals.find((terminal) => terminal.process.session_id === terminalId)!.process.status).toBe("running");
    await page.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect.poll(async () => (await current(page))?.run?.status, { timeout: 15000 }).toBe("completed");
    expect(requests).toHaveLength(4);
    expect(await prompt.inputValue()).toBe("保留未发送的独立草稿");
    await page.getByRole("button", { name: "继续队列", exact: true }).click();
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(5);
    expect(requests[4]).toContain("第二条排队追问");
    expect(requests[4]).not.toContain("保留未发送的独立草稿");

    await prompt.focus();
    await prompt.press("Control+Backquote");
    await screen.waitFor();
    expect(await page.getByRole("tab", { name: "1", exact: true }).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("button", { name: "新终端", exact: true }).click();
    await expect.poll(async () => (await current(page))!.terminals.length).toBe(2);
    expect(await page.getByRole("tab", { name: "2", exact: true }).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("tab", { name: "1", exact: true }).click();
    await expect.poll(() => screen.innerText()).toContain("terminal-alive");
    await screen.click();
    await page.keyboard.press("Control+Backquote");
    await drawer.waitFor({ state: "hidden" });
    await prompt.focus();
    await prompt.press("Control+Backquote");
    await screen.waitFor();
    await newConversation(page);
    const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
    await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill("独立的另一条对话");
    await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
    await page.getByRole("heading", { name: "独立的另一条对话", exact: true }).waitFor();
    expect(await page.evaluate(async (id) => (await window.noemori.agent.snapshot(id)).terminals.every((terminal) => terminal.process.status === "running"), id)).toBe(true);
    await openLibrary(page);
    await page.getByRole("button", { name: "继续与终端验收", exact: true }).click();
    await expect.poll(() => prompt.inputValue()).toBe("保留未发送的独立草稿");
    await page.reload();
    await page.waitForLoadState("load");
    expect(await page.evaluate(async ({ id, terminalId }) => (await window.noemori.agent.snapshot(id)).terminals.find((terminal) => terminal.process.session_id === terminalId)!.process.status, { id, terminalId })).toBe("running");
    await app.close();
  } finally { await app.close(); }
});
