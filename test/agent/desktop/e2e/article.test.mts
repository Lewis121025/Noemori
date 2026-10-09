import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright-core";
import { expect, test } from "vitest";
import { openLibrary } from "../../../notes/desktop/support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("文章对话：插入、悬停、定位、每轮上下文、文件归属和随库迁移", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-article-e2e-"));
  test.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "vault"));
  await mkdir(join(root, "state"));
  let vault = await realpath(join(root, "vault"));
  const state = join(root, "state");
  await writeFile(
    join(vault, "光学.md"),
    "# 光学\n\n第一段介绍光。\n\n折射发生在两种介质的交界处。\n",
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({ vaultRoot: vault, currentPath: "光学.md" }),
  );
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `article-${requests.length}`,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "光在不同介质中的传播速度不同。" },
          },
        ],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  test.onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("模型未监听");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${state}`],
      cwd: fileURLToPath(desktop),
      env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
      colorScheme: null,
    });
  let app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".ProseMirror").filter({ hasText: "折射发生" }).waitFor();
  await page.evaluate(
    (endpoint) =>
      window.noemori.agent.providersSave({
        protocol: "openai-chat",
        id: null,
    name: "测试供应商",
        address: { type: "endpoint", url: endpoint },
        authentication: { type: "none" },
        models: [{ id: "article-fixture", tools: true,
        streaming: false,
        vision: false,
        audio: false,
        video: false }],
      }),
    `http://127.0.0.1:${address.port}/model`,
  );
  const paragraph = page.locator(".ProseMirror p").filter({ hasText: "折射发生" });
  await paragraph.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "插入 Agent 对话…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "在此处插入对话", exact: true });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await page.evaluate(() => window.noemori.agent.list())).items).toHaveLength(0);
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "插入 Agent 对话…", exact: true }).click();
  await dialog.getByRole("textbox", { name: "对话名称", exact: true }).fill("理解折射");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
  );
  await page.waitForFunction(() => innerWidth === 640 && innerHeight === 480);
  expect(
    (await dialog.locator("footer").boundingBox())!.y +
      (await dialog.locator("footer").boundingBox())!.height,
  ).toBeLessThan(472);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720),
  );
  await dialog.getByRole("button", { name: "插入对话", exact: true }).click();
  await page.getByRole("heading", { name: "理解折射", exact: true }).waitFor();
  const id = (await page.evaluate(() => window.noemori.agent.list())).items[0]!.id;
  const snapshot = () => page.evaluate((id) => window.noemori.agent.snapshot(id), id);
  expect((await snapshot()).article).toMatchObject({
    path: "光学.md",
    status: "located",
    heading: "光学",
  });
  expect(await readFile(join(vault, "光学.md"), "utf8")).toContain(`noemori://conversation/${id}`);
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "article-fixture", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Agent 用户任务" });
  await input.fill("为什么会折射？");
  await input.press("Enter");
  await expect.poll(async () => (await snapshot()).run?.status).toBe("completed");
  expect(requests[0]).toContain("折射发生在两种介质");
  expect(requests[0]).toContain("article_path");
  expect(requests[0]).toContain("光学.md");
  await page.locator(".article-link").click();
  const marker = page.locator(`.ProseMirror a[href="noemori://conversation/${id}"]`);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(() => marker.count()).toBe(0);
  expect((await page.evaluate(() => window.noemori.agent.list())).items).toHaveLength(1);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await marker.waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(640, 480),
  );
  await page.waitForFunction(() => innerWidth === 640 && innerHeight === 480);
  await page.locator(".file-sidebar:not(.right)").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await marker.hover();
  const preview = page.getByRole("complementary", { name: "文章对话预览", exact: true });
  await preview.getByText("光在不同介质中的传播速度不同。", { exact: true }).waitFor();
  const previewBounds = (await preview.boundingBox())!;
  const markerBounds = (await marker.boundingBox())!;
  expect(
    previewBounds.y + previewBounds.height <= markerBounds.y ||
      previewBounds.y >= markerBounds.y + markerBounds.height,
  ).toBe(true);
  const shots = process.env["NOEMORI_ARTICLE_SHOTS"];
  if (shots) {
    await mkdir(shots, { recursive: true });
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const [width, height] = window.getContentSize();
      return (await window.capturePage()).resize({ width, height }).toPNG();
    });
    await writeFile(join(shots, "article-popup.png"), bytes);
  }
  expect(
    (await preview.boundingBox())!.y + (await preview.boundingBox())!.height,
  ).toBeLessThanOrEqual(480);
  await preview.getByRole("button", { name: "打开对话", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720),
  );
  await page.getByRole("heading", { name: "理解折射", exact: true }).waitFor();
  await page.locator(".article-link").click();
  await openLibrary(page);
  const file = page.locator('.library [data-path="光学.md"]');
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名…", exact: true }).click();
  const renameField = page.locator("input.inline-rename");
  await renameField.fill("折射原理.md");
  await renameField.press("Enter");
  await expect.poll(async () => (await snapshot()).article?.path).toBe("折射原理.md");
  await page.locator('.library [data-path="折射原理.md"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "查看文章对话", exact: true }).click();
  await expect.poll(() => page.getByRole("log", { name: "对话消息" }).innerText()).toContain("光在不同介质中的传播速度不同");
  await page.getByRole("heading", { name: "理解折射", exact: true }).waitFor();
  await input.fill("继续解释这一段。");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  await expect.poll(async () => (await snapshot()).run?.status).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("折射原理.md");
  expect(errors).toEqual([]);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
    ),
  ).toBe(true);
  await app.close();
  const damaged: { id: string; title: string; snapshot: { id: string }; checkpoint: string } =
    JSON.parse(
      await readFile(join(vault, ".noemori", "agent", "conversations", `${id}.json`), "utf8"),
    );
  damaged.id = randomUUID();
  damaged.snapshot.id = damaged.id;
  damaged.title = "损坏的记录";
  damaged.checkpoint = JSON.stringify({ ...JSON.parse(damaged.checkpoint), history: [] });
  const damagedName = `${damaged.id}.json`,
    damagedContent = JSON.stringify(damaged);
  await writeFile(join(vault, ".noemori", "agent", "conversations", damagedName), damagedContent);
  await rename(vault, join(root, "moved-vault"));
  vault = await realpath(join(root, "moved-vault"));
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({ vaultRoot: vault, currentPath: "折射原理.md" }),
  );
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.locator(`.ProseMirror a[href="noemori://conversation/${id}"]`).click();
  await page.getByRole("heading", { name: "理解折射", exact: true }).waitFor();
  expect((await snapshot()).workspace).toBe(vault);
  expect((await page.evaluate(() => window.noemori.agent.list())).issues.join(" ")).toContain(
    "损坏的记录",
  );
  expect(
    await readFile(join(vault, ".noemori", "agent", "conversations", damagedName), "utf8"),
  ).toBe(damagedContent);
  await page.getByRole("textbox", { name: "Agent 用户任务" }).fill("迁移后继续");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(async () => (await snapshot()).run?.status).toBe("completed");
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContain("moved-vault");
  await rm(join(vault, "折射原理.md"));
  await expect.poll(async () => (await snapshot()).article?.status).toBe("article-missing");
  expect((await page.evaluate(() => window.noemori.agent.list())).items).toHaveLength(1);
  expect(
    await readFile(join(vault, ".noemori", "agent", "conversations", `${id}.json`), "utf8"),
  ).toContain("理解折射");
  await app.close();
}, 45000);
