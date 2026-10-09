import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { expect, test } from "vitest";
import { openLibrary, newEntry, newConversation, openSettings } from "../support/workspace-actions";
const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("层级工作台：真实全文、修改时间、文章对话、创建位置与窄屏焦点", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-hierarchy-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(join(vault, "研究/光学"), { recursive: true });
  await mkdir(join(vault, "归档"));
  await mkdir(state);
  vault = await realpath(vault);
  const path = "研究/光学/折射与斯涅尔定律.md";
  const source =
    "# 折射与斯涅尔定律\n\n## 角度的定义\n\n入射角与折射角都以界面法线为基准。光线与法线位于同一个平面内。\n\n$$n_1 \\sin \\theta_1 = n_2 \\sin \\theta_2$$\n\n## 从空气进入玻璃\n\n介质的折射率增大时，光线向法线偏折。\n";
  await writeFile(join(vault, path), source);
  await writeFile(join(vault, "研究/光学/波前.md"), "# 惠更斯原理\n\n次级波面描述波前的传播。\n");
  await writeFile(join(vault, "归档/折射摘录.md"), "# 折射摘录\n\n整理教材与实验出处。\n");
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: path, filesCollapsed: false },
      appearance: "light",
    }),
  );
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "workspace-reply", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "角度以界面法线为基准。\n\n从空气进入玻璃时，折射率增大，折射角变小，光线向法线偏折。\n\n可以把入射角设为 30°，用斯涅尔定律核对折射角。" } }] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.onTestFinished(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地模型未监听");
  const endpoint = `http://127.0.0.1:${address.port}/model`;
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", NOEMORI_TEST_WINDOW: "hidden" },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1120, height: 800 });
    await openLibrary(page);
    const files = page.getByRole("navigation", { name: "文件列表" });
    const row = (path: string) => files.locator(`button[data-path="${path}"]`);
    const input = files.getByRole("searchbox");
    const editor = page.locator(".reading-space .ProseMirror");
    await row(path).click();
    await editor.getByRole("heading", { name: "角度的定义" }).waitFor();
    expect(await page.locator(".library-preview").count()).toBe(0);
    await input.fill("法线");
    await files.locator(".excerpt").waitFor();
    expect(await row("研究").count()).toBe(1);
    expect(await row("研究/光学").count()).toBe(1);
    await input.press("ArrowDown");
    expect(await row(path).evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    expect(await files.locator('[aria-selected="true"]').count()).toBe(1);
    await files.getByRole("button", { name: /查看 .* 的命中详情/ }).click();
    await files.locator(".occurrence").first().click();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("法线");
    await input.press("Escape");
    await row(path).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名…", exact: true }).click();
    const rename = files.getByRole("textbox", { name: "重命名文件", exact: true });
    expect(await rename.evaluate(node => {
      if (!(node instanceof HTMLInputElement)) throw new Error("重命名控件不是输入框");
      return node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0);
    })).toBe("折射与斯涅尔定律");
    await rename.press("Escape");
    await newEntry(page, "笔记");
    const creation = page.getByRole("dialog", { name: "新建笔记", exact: true });
    expect(await creation.locator(".destination").innerText()).toContain("研究/光学/");
    await creation.getByRole("button", { name: "取消", exact: true }).click();
    await openSettings(page);
    await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: "关闭设置" }).click();
    const conversation = await page.evaluate(
      async ({ root, path, endpoint }) => {
        await window.noemori.agent.providersSave({
          protocol: "openai-chat",
          id: null,
          name: "本地测试供应商",
          address: { type: "endpoint", url: endpoint },
          authentication: { type: "none" },
          models: [
            {
              id: "local-fixture",
              tools: true,
              streaming: false,
              vision: false,
              audio: false,
              video: false,
            },
          ],
        });
        await window.noemori.agent.attachVault(root);
        return window.noemori.agent.createArticle({ root, path, title: "理解折射" });
      },
      { root: vault, path, endpoint },
    );
    await writeFile(
      join(vault, path),
      `${source}\n[讨论：理解折射](noemori://conversation/${conversation.id})\n`,
    );
    await editor.locator(`a[href="noemori://conversation/${conversation.id}"]`).waitFor();
    const expandChats = files.getByRole("button", { name: /折射与斯涅尔定律：展开或收起对话/ });
    if (await expandChats.getAttribute("aria-expanded") !== "true") await expandChats.click();
    const chat = files.getByRole("button", { name: "理解折射", exact: true });
    const original = await editor.elementHandle();
    await chat.click();
    const panel = page.locator(".agent-panel");
    await panel.getByRole("heading", { name: "理解折射", exact: true }).waitFor();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    const draft = panel.getByRole("textbox", { name: "Agent 用户任务" });
    await draft.fill("为什么光线向法线偏折？");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel.getByText("从空气进入玻璃时，折射率增大，折射角变小，光线向法线偏折。", { exact: true }).waitFor();
    expect(requests[0]).toContain("折射与斯涅尔定律");
    expect(requests[0]).toContain("article_path");
    await draft.fill("下次继续讨论折射率");
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await page.locator(".file-sidebar.right").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    expect(await draft.inputValue()).toBe("下次继续讨论折射率");
    await newConversation(page);
    const independent = page.getByRole("dialog", { name: "新建对话", exact: true });
    expect(await independent.getByRole("combobox", { name: "关联目录", exact: true }).inputValue()).toBe(join(vault, "研究/光学"));
    await independent.getByRole("textbox", { name: "会话名称", exact: true }).fill("独立探索");
    await independent.getByRole("button", { name: "创建对话", exact: true }).click();
    await panel.getByRole("heading", { name: "独立探索", exact: true }).waitFor();
    expect(requests).toHaveLength(1);
    await chat.click();
    expect(await draft.inputValue()).toBe("下次继续讨论折射率");
    const fork = await page.evaluate(async id => window.noemori.agent.fork(id, { title: "玻璃中的传播", afterTurnId: null }), conversation.id);
    await input.fill("玻璃中的传播");
    await files.getByRole("button", { name: "玻璃中的传播", exact: true }).waitFor();
    expect(await chat.count()).toBe(1);
    expect(await row(path).count()).toBe(1);
    await input.press("Escape");
    const shots = process.env.NOEMORI_FILE_MANAGER_SCREENSHOTS;
    if (shots) await page.screenshot({ path: join(shots, "workspace-wide.png") });
    await page.setViewportSize({ width: 640, height: 480 });
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await openLibrary(page);
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    expect(await draft.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: join(shots, "workspace-narrow.png") });
    expect((await page.evaluate(async id => window.noemori.agent.snapshot(id), fork.id)).article?.path).toBe(path);
    expect(errors).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((win) => !win.isVisible() && !win.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
