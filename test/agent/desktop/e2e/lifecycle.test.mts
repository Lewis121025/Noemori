import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { _electron as electron, type Page } from "playwright-core";
import { expect, test } from "vitest";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function snapshot(page: Page, id?: string) {
  return page.evaluate(async (id) => {
    const chosen = id ?? (await window.noemori.agent.list()).items[0]?.id;
    return chosen ? window.noemori.agent.snapshot(chosen) : null;
  }, id);
}

test("隐藏窗口验证中断继续、历史分叉、来源定位与跨进程恢复", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-lifecycle-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  const outside = join(root, "outside");
  await writeFile(outside, "permission fixture");
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const message =
      requests.length === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "pending",
                type: "function",
                function: {
                  name: "terminal",
                  arguments: JSON.stringify({
                    action: "exec",
                    cmd: "touch should-not-run",
                    permission_request: { reason: "测试等待审批的中断", readable_paths: [outside] },
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content:
              requests.length === 2
                ? "中断后已核实，继续第一条思路。"
                : requests.length === 3
                  ? "这段只属于来源会话后续。"
                  : "分支已经独立继续。",
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `lifecycle-${requests.length}`,
        choices: [
          { index: 0, message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" },
        ],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型 fixture 未监听");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
      cwd: fileURLToPath(desktop),
      colorScheme: null,
      env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
    });
  let app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.waitForLoadState("load");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const assertHidden = async () => {
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      ),
    ).toEqual([{ visible: false, focused: false }]);
  };
  await assertHidden();
  await page.evaluate(
    (endpoint) =>
      window.noemori.agent.providersSave({
        protocol: "openai-chat",
        id: null,
    name: "测试供应商",
        address: { type: "endpoint", url: endpoint },
        authentication: { type: "none" },
        models: [{ id: "lifecycle-fixture", tools: true,
        streaming: false,
        vision: false,
        audio: false,
        video: false }],
      }),
    `http://127.0.0.1:${address.port}/model`,
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新会话", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新建对话", exact: true });
  await creation.getByRole("textbox", { name: "会话名称", exact: true }).fill("中断和分叉");
  await creation.getByRole("button", { name: "选择文件夹…", exact: true }).click();
  await creation.getByRole("button", { name: "创建对话", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Agent 用户任务" });
  await input.fill("记住第一条思路，并等待审批");
  await input.press("Enter");
  await page.getByRole("region", { name: "权限审批", exact: true }).waitFor();
  const sourceId = (await snapshot(page))!.id;
  await input.fill("保留这段未发送的草稿");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
  expect((await snapshot(page, sourceId))?.run?.status).toBe("cancelled");
  await expect(readFile(join(workspace, "should-not-run"))).rejects.toThrow();
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect.poll(async () => (await snapshot(page, sourceId))?.run?.status).toBe("completed");
  expect(await input.inputValue()).toBe("保留这段未发送的草稿");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("记住第一条思路");
  const branchPoint = (await snapshot(page, sourceId))!.turns[1]!.run.id;
  await input.fill("后来补充的第二条思路");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(async () => (await snapshot(page, sourceId))?.run?.status).toBe("completed");
  const original = (await snapshot(page, sourceId))!;
  await page
    .locator(`[data-turn-id="${branchPoint}"]`)
    .getByRole("button", { name: "从此轮分叉", exact: true })
    .click();
  const fork = page.getByRole("dialog", { name: "分叉对话", exact: true });
  await fork.getByRole("textbox", { name: "分支名称", exact: true }).fill("另一个方向");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
  );
  await page.waitForFunction(() => innerWidth === 640 && innerHeight === 480);
  const footer = (await fork.locator("footer").boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(464);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720),
  );
  await fork.getByRole("button", { name: "创建分支", exact: true }).click();
  await expect
    .poll(() => page.locator(".conversation-heading h1").textContent())
    .toBe("另一个方向");
  const branchId = (await snapshot(page))!.id;
  const branched = (await snapshot(page, branchId))!;
  expect(branched.origin).toMatchObject({ conversationId: sourceId, turnId: branchPoint });
  expect(branched.turns).toHaveLength(2);
  expect(branched.approvals).toEqual([]);
  expect(branched.terminals).toEqual([]);
  expect(JSON.stringify(branched.messages)).not.toContain("后来补充的第二条思路");
  expect(requests).toHaveLength(3);
  await page
    .getByRole("navigation", { name: "对话关系", exact: true })
    .getByRole("button", { name: "中断和分叉", exact: true })
    .click();
  await expect
    .poll(() => page.locator(`[data-turn-id="${branchPoint}"]`).getAttribute("class"))
    .toContain("linked");
  expect((await snapshot(page, sourceId))!.messages).toEqual(original.messages);
  await page.locator(".conversation-item").filter({ hasText: "另一个方向" }).click();
  await input.fill("沿分支继续");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(4);
  await expect.poll(async () => (await snapshot(page, branchId))?.run?.status).toBe("completed");
  expect(requests[3]).toContain("中断后已核实");
  expect(requests[3]).not.toContain("后来补充的第二条思路");
  await assertHidden();
  expect(errors).toEqual([]);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.waitForLoadState("load");
  await assertHidden();
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await expect
    .poll(() => page.locator(".conversation-heading h1").textContent())
    .toBe("另一个方向");
  expect((await snapshot(page, branchId))!.origin).toEqual(branched.origin);
  expect(requests).toHaveLength(4);
  await app.close();
}, 45000);
