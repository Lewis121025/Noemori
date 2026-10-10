import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("桌面浏览器从来源审批到表单操作、视觉回传与人工接管完整闭环", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-browser-desktop-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);
  let origin = "";
  let calls = 0;
  let sawImage = false;
  let pageId = "";
  let filledBeforeCancel = false;
  const failures: string[] = [];
  const server = createServer(async (input, output) => {
    if (input.url === "/filled") {
      filledBeforeCancel = true;
      output.writeHead(204);
      output.end();
      return;
    }
    if (input.url !== "/model") {
      output.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      output.end(
        input.url === "/cancel"
          ? "<title>取消批量验收</title><label>姓名<input oninput=\"fetch('/filled')\"></label><button disabled>保存</button>"
          : `<title>阅读清单</title>
            <style>
              * { box-sizing: border-box; } body { margin: 0; color: #374b40; background: #f5f7f2; font: 22px -apple-system, sans-serif; }
              main { max-width: 1040px; margin: 70px auto; } .eyebrow { font-size: 17px; letter-spacing: 3px; color: #819182; }
              h1 { margin: 18px 0; font-size: 48px; font-weight: 500; letter-spacing: -1px; }
              .intro { color: #7b887c; line-height: 1.8; } article { margin: 42px 0 26px; padding: 34px 40px; border: 1px solid #dce4d8; border-radius: 20px; background: #fdfefa; }
              h2 { margin: 12px 0; font-size: 28px; font-weight: 500; } article p { color: #7b887c; line-height: 1.9; }
              .tag { display: inline-block; border-radius: 20px; padding: 7px 14px; color: #697f68; background: #ebf0e5; font-size: 16px; }
              .form { display: flex; align-items: center; gap: 14px; padding: 24px 30px; border-radius: 16px; background: #eaf0e5; font-size: 18px; }
              input { margin-left: 12px; padding: 10px 14px; border: 1px solid #cad5c5; border-radius: 8px; font: inherit; color: inherit; background: #fdfefa; }
              button { padding: 10px 20px; border: 0; border-radius: 8px; font: inherit; color: white; background: #778d70; } output { margin-left: auto; color: #7c8f76; font-size: 16px; }
            </style>
            <main><div class="eyebrow">READING NOTES</div><h1>留一点时间，理解一个想法。</h1>
              <p class="intro">把值得再次翻阅的内容，整理在同一个地方。</p>
              <article><span class="tag">本周阅读</span><h2>从观察开始，慢慢建立自己的理解</h2><p>阅读的时候，留意那些让你停顿的句子。<br>记录一个问题、一段联系，或是一个还没成形的想法。</p></article>
              <div class="form"><label>姓名<input></label><button onclick="document.querySelector('output').textContent='已保存：'+document.querySelector('input').value">保存</button><output></output></div>
            </main>`,
      );
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      const request: { messages: { role: string; content: unknown }[] } = JSON.parse(
        Buffer.concat(chunks).toString(),
      );
      calls++;
      const last = request.messages.filter((message) => message.role === "tool").at(-1);
      const result: {
        output: {
          prints?: { observation?: {
            page: string;
            id: string;
            text: string;
            elements: { ref: string; description: string }[];
          } }[];
        };
      } | null = last && typeof last.content === "string" ? JSON.parse(last.content) : null;
      const observation = result?.output.prints?.at(-1)?.observation;
      if (observation) pageId = observation.page;
      const element = (name: string) => {
        if (!observation) throw new Error("模型未收到页面观察");
        const match = observation.elements.find((element) => element.description.includes(name));
        if (!match) throw new Error(`观察缺少 ${name}`);
        return { page: observation.page, observation: observation.id, ref: match.ref };
      };
      let action: object | null = null;
      if (calls === 1)
        action = { action: "request_access", origin, reason: "操作用户指定的本机验收页面" };
      if (calls === 2) action = { action: "open", url: `${origin}/page` };
      if (calls === 3) action = { action: "scroll", page: pageId, observation: observation?.id, x: 0, y: 450 };
      if (calls === 4) action = { action: "fill", ...element("姓名"), text: "验收用户" };
      if (calls === 5) action = { action: "click", ...element("保存") };
      if (calls === 6) {
        expect(observation?.text).toContain("已保存：验收用户");
        action = { action: "screenshot", page: pageId };
      }
      if (calls === 7) {
        sawImage = request.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part: { type?: string }) => part.type === "image_url"),
        );
        expect(sawImage).toBe(true);
      }
      if (calls === 8) action = { action: "handoff", completion: { page: pageId, until: { type: "text", text: "已保存：验收用户人工用户" } } };
      if (calls === 9) action = { action: "observe", page: pageId };
      if (calls === 10) expect(observation?.text).toContain("已保存：验收用户人工用户");
      if (calls === 11) action = { action: "navigate", page: pageId, url: `${origin}/cancel` };
      if (calls === 12)
        action = {
          action: "batch",
          page: pageId,
          observation: observation?.id,
          steps: [
            { action: "fill", ref: element("姓名").ref, text: "取消验收" },
            { action: "click", ref: element("保存").ref },
          ],
        };
      const message = action
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `browser-${calls}`,
                type: "function",
                function: { name: "ui_repl", arguments: JSON.stringify({type:"run",code:`var uiResult=await (await browser.get('managed')).action(${JSON.stringify(action)}); print(uiResult); if(uiResult.image) emitImage(uiResult);`}) },
              },
            ],
          }
        : { role: "assistant", content: "已确认保存结果" };
      output.writeHead(200, { "content-type": "application/json" });
      output.end(
        JSON.stringify({
          id: `result-${calls}`,
          choices: [{ index: 0, message, finish_reason: action ? "tool_calls" : "stop" }],
        }),
      );
    } catch (error) {
      failures.push(String(error));
      output.writeHead(500);
      output.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("验收站点未启动");
  origin = `http://127.0.0.1:${address.port}`;
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    cwd: fileURLToPath(desktop),
    env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.evaluate(
    async (endpoint) =>
      window.noemori.agent.providersSave({
        id: null,
        name: "浏览器测试供应商",
        protocol: "openai-chat",
        address: { type: "endpoint", url: endpoint },
        authentication: { type: "none" },
        models: [
          {
            id: "browser-fixture",
            tools: true,
            streaming: false,
            vision: true,
            audio: false,
            video: false,
          },
        ],
      }),
    `${origin}/model`,
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新建对话", exact: true });
  await creation.getByRole("button", { name: "关联文件夹…", exact: true }).click();
  await creation.getByRole("button", { name: "创建对话", exact: true }).click();
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "browser-fixture", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Agent 用户任务" })
    .fill("在验收页面填写并保存姓名，再检查截图");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".approval").waitFor();
  expect(await page.locator(".approval").textContent()).toContain(origin);
  await page.getByRole("button", { name: "此会话允许", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id))
              ?.run?.status,
        ),
      {
        timeout: 30000,
      },
    )
    .not.toBe("running");
  const initial = await page.evaluate(async () => window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id));
  expect(initial.run, JSON.stringify({ calls, failures, browser: initial.browser, ui: initial.ui, last: initial.messages.at(-1) }).slice(0, 8000)).toMatchObject({ status: "completed" });
  expect(failures).toEqual([]);
  expect({
    calls,
    sawImage,
    browser: await page.evaluate(
      async () =>
        (await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id))
          ?.browser,
    ),
  }).toMatchObject({ calls: 7, sawImage: true });
  expect(await page.getByRole("region", { name: "会话浏览器" }).count()).toBe(0);
  const panel = page.getByRole("dialog", { name: "浏览器协助" });
  expect(await panel.count()).toBe(0);
  await page.getByRole("textbox", { name: "Agent 用户任务" }).fill("需要用户验证后继续检查页面");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id)).run?.status), { timeout: 15000 }).toBe("paused");
  await panel.waitFor();
  expect(await panel.locator("button, nav, form").count()).toBe(0);
  expect(await page.locator(".agent-preview").count()).toBe(0);
  const artifacts = process.env["NOEMORI_QUALITY_ARTIFACTS"];
  if (artifacts) {
    await mkdir(join(artifacts, "browser"), { recursive: true });
    const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString("base64"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(artifacts, "browser", "assistance.png"), Buffer.from(image, "base64"));
  }
  const before = await page.evaluate(async () => window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id));
  const target = before.browser.tabs[0]!.native_target;
  if (!target) throw new Error("Rust→Node→Electron 未交付真实页面身份");
  const typed = await app.evaluate(async ({ webContents }, target) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.debugger.isAttached()) continue;
      const { targetInfo } = await contents.debugger.sendCommand("Target.getTargetInfo");
      if (targetInfo.targetId !== target) continue;
      // 小窗改变页面可见高度；先滚动到表单，再按当前视口坐标输入。
      await contents.executeJavaScript("document.querySelector('input').scrollIntoView({block:'center'})");
      const positions: { input: { x: number; y: number }; button: { x: number; y: number } } = await contents.executeJavaScript(`(() => {
        const point = (selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; };
        return { input: point('input'), button: point('button') };
      })()`);
      contents.focus();
      for (const type of ["mouseDown", "mouseUp"] as const) contents.sendInputEvent({ type, ...positions.input, button: "left", clickCount: 1 });
      await contents.insertText("人工用户");
      for (const type of ["mouseDown", "mouseUp"] as const) contents.sendInputEvent({ type, ...positions.button, button: "left", clickCount: 1 });
      return contents.executeJavaScript("document.querySelector('output').textContent");
    }
    throw new Error("真实网页未连接");
  }, target);
  expect(typed).toContain("已保存：验收用户人工用户");
  await panel.waitFor({ state: "hidden" });
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id);
    return { status: snapshot.run?.status, run: snapshot.run?.id, users: snapshot.messages.filter((message) => message.role === "user").length };
  }), { timeout: 15000 }).toEqual({ status: "completed", run: before.run!.id, users: 2 });
  expect(failures).toEqual([]);
  await page
    .getByRole("textbox", { name: "Agent 用户任务" })
    .fill("填写姓名并保存，在等待保存时停止");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => filledBeforeCancel, { timeout: 15000 }).toBe(true);
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id))
            ?.run?.status,
      ),
    )
    .toBe("cancelled");
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = await window.noemori.agent.snapshot((await window.noemori.agent.list()).items[0]!.id);
    return snapshot.browser.receipts.findLast((receipt) => receipt.action === "batch")?.steps.map((step) => step.outcome);
  }), { timeout: 15000 }).toEqual(["executed", "not_executed"]);
  expect(calls).toBe(12);
  expect(await panel.count()).toBe(0);
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "删除对话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除对话", exact: true })
    .getByRole("button", { name: "删除对话", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(async () => (await window.noemori.agent.list()).items.map((item) => (item.id))), { timeout: 15000 })
    .toEqual([]);
  await app.close();
}, 60000);
