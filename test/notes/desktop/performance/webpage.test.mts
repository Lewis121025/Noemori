import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { checkBudget } from "./budget";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("500 个网页的布局预算、浏览实例上限与输入保护", { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-webpage-performance-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.set(path, (requests.get(path) ?? 0) + 1);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      '<title>性能网页</title><h1>性能网页</h1><input aria-label="待保留输入"><p>网页正文</p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("性能网页未启动");
  const origin = `http://127.0.0.1:${address.port}`;
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const source = Array.from(
    { length: 500 },
    (_, index) =>
      `网页 ${index}\n\n\`\`\`webpage\n${JSON.stringify({ url: `${origin}/page/${index}`, height: 480 })}\n\`\`\`\n`,
  ).join("\n");
  await writeFile(join(vault, "Home.md"), "# 多网页性能测试\n\n" + source);
  await writeFile(join(vault, "Other.md"), "# 其他文档\n");
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "Home.md", filesCollapsed: false, leftWidth: 232 },
      appearance: "light",
      window: null,
    }),
  );
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.locator(".webpage-embed").count()).toBe(500);
    try {
      await expect
        .poll(() => page.locator(".webpage-address").first().textContent(), { timeout: 8000 })
        .toContain("性能网页");
    } catch (error) {
      console.info(
        JSON.stringify(
          await page.evaluate(() => ({
            ready: document.readyState,
            error: document.querySelector(".webpage-surface")?.textContent,
            hidden: document.hidden,
            inert: document.querySelector(".webpage-surface")?.closest("[inert]") !== null,
          })),
        ),
      );
      throw error;
    }
    const benchmark = await page.evaluateHandle(() => {
      const originalRect = Element.prototype.getBoundingClientRect;
      const originalFrame = window.requestAnimationFrame;
      let reads = 0;
      const durations: number[] = [];
      Element.prototype.getBoundingClientRect = function () {
        if (this.classList.contains("webpage-surface")) reads++;
        return originalRect.call(this);
      };
      window.requestAnimationFrame = (callback) =>
        originalFrame((time) => {
          const before = reads;
          const start = performance.now();
          callback(time);
          if (reads > before) durations.push(performance.now() - start);
        });
      return {
        async sample(count: number) {
          const scroller = document.querySelector(".main");
          if (!(scroller instanceof HTMLElement)) throw new Error("缺少正文滚动区");
          for (let index = 0; index < count; index++) {
            scroller.scrollTop = index % 2 === 0 ? 1 : 2;
            scroller.dispatchEvent(new Event("scroll"));
            await new Promise<void>((resolve) =>
              originalFrame(() => originalFrame(() => resolve())),
            );
          }
          return { reads, durations: [...durations] };
        },
        reset() {
          reads = 0;
          durations.length = 0;
        },
        restore() {
          Element.prototype.getBoundingClientRect = originalRect;
          window.requestAnimationFrame = originalFrame;
        },
      };
    });
    await benchmark.evaluate((value) => value.sample(5));
    await benchmark.evaluate((value) => value.reset());
    const samples = await benchmark.evaluate((value) => value.sample(40));
    await benchmark.evaluate((value) => value.restore());
    await benchmark.dispose();

    const guest = app
      .context()
      .pages()
      .find((item) => item.url() === `${origin}/page/0`);
    if (!guest) throw new Error("首个网页未创建");
    await guest.getByLabel("待保留输入").fill("这段尚未提交的输入必须保留");
    const countViews = () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.contentView.children.filter(
            (view) => view.children.length > 0,
          ).length ?? 0,
      );
    let peak = await countViews();
    for (let index = 1; index < 20; index++) {
      await page
        .locator(".webpage-surface")
        .nth(index)
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect
        .poll(() => page.locator(".webpage-address").nth(index).textContent())
        .toContain("性能网页");
      peak = Math.max(peak, await countViews());
    }
    const retained = await countViews();
    console.info(
      JSON.stringify({
        scenario: "webpage-layout-and-memory",
        nodes: 500,
        scrolls: 40,
        pageRectReads: samples.reads,
        peakViews: peak,
        retainedViews: retained,
        layoutP95: [...samples.durations].sort((a, b) => a - b)[
          Math.ceil(samples.durations.length * 0.95) - 1
        ],
      }),
    );
    expect(retained).toBeLessThanOrEqual(8);
    expect(samples.reads).toBeLessThanOrEqual(40 * 6);
    expect(await guest.getByLabel("待保留输入").inputValue()).toBe("这段尚未提交的输入必须保留");
    const beforeReload = requests.get("/page/1") ?? 0;
    await page
      .locator(".webpage-surface")
      .nth(1)
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => requests.get("/page/1") ?? 0).toBeGreaterThan(beforeReload);
    await page.getByRole("treeitem", { name: "Other.md", exact: true }).dblclick();
    await page.getByRole("heading", { name: "其他文档" }).waitFor();
    await expect.poll(countViews).toBe(0);
    await checkBudget("webpage-layout-500", samples.durations, 8);
  } finally {
    await app.close();
  }
});
