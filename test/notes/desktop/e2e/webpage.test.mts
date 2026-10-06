import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { _electron as electron, type Page } from "playwright-core";
import { openLibrary } from "../support/workspace-actions";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("正文实时网页：插入保存、滚动点击、独立历史、模态裁剪与卸载释放", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-webpage-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let offline = true;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    // 禁止 iframe 的站点仍能在独立沙箱视图内浏览。
    response.setHeader("X-Frame-Options", "DENY");
    if (request.url === "/offline" && offline) {
      response.destroy();
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "file:///etc/passwd" });
      response.end();
      return;
    }
    response.end(
      request.url === "/next"
        ? '<title>第二页</title><h1>网页第二页</h1><a href="/page">返回首页</a>'
        : '<title>嵌入网页测试</title><h1>实时网页</h1><input aria-label="网页输入"><button onclick="this.textContent=\'点击成功\'">测试点击</button><a href="/next" target="_blank">下一页</a><a href="/redirect">无效重定向</a><div style="height:2200px;background:linear-gradient(#fff,#cdf)">滚动区域</div><p>网页底部标记</p>',
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
  if (!address || typeof address === "string") throw new Error("测试网页未启动");
  const origin = `http://127.0.0.1:${address.port}`;
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await writeFile(
    join(vault, "Home.md"),
    "# 网页测试\n\n插入位置\n\n后文保留\n\n" + "正文滚动测试段落。\n\n".repeat(20),
  );
  await writeFile(join(vault, "Other.md"), "# 其他笔记\n");
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: {
        vaultRoot: vault,
        currentPath: "Home.md",
        filesCollapsed: false,
        leftWidth: 232,
      },
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
  const launch = () =>
    electron.launch({
      executablePath: executable,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      env,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const command = async (id: string) =>
      app.evaluate(({ Menu }, action) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(action);
        if (!item) throw new Error(`缺少命令 ${action}`);
        item.click();
      }, id);
    await page.locator(".ProseMirror").getByText("插入位置", { exact: true }).click();
    await command("insert-webpage");
    const dialog = page.getByRole("dialog", { name: "插入网页", exact: true });
    await dialog.getByLabel("网页地址").fill(`${origin}/page`);
    await dialog.getByLabel("显示高度（像素）").fill("360");
    await dialog.getByRole("button", { name: "插入", exact: true }).click();
    await page
      .locator(".webpage-address")
      .getByText(/嵌入网页测试/)
      .waitFor();
    await command("save");
    await expect
      .poll(() => readFile(join(vault, "Home.md"), "utf8"))
      .toContain(`"url":"${origin}/page"`);
    const saved = await readFile(join(vault, "Home.md"), "utf8");
    expect(saved).toContain('"height":360');
    expect(saved).toContain("后文保留");
    let guest: Page | undefined;
    await expect
      .poll(() => {
        guest = app
          .context()
          .pages()
          .find((item) => item.url() === `${origin}/page`);
        return guest !== undefined;
      })
      .toBe(true);
    if (!guest) throw new Error("未找到网页视图");
    expect(
      await guest.evaluate(() => ({ node: typeof window.require, app: typeof window.noemori })),
    ).toEqual({ node: "undefined", app: "undefined" });
    await guest.getByRole("button", { name: "测试点击" }).click();
    await guest.getByRole("button", { name: "点击成功" }).waitFor();
    await guest.getByLabel("网页输入").fill("网页输入不会写入笔记");
    await guest.mouse.wheel(0, 500);
    await expect.poll(() => guest?.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await guest.evaluate(() => window.scrollTo(0, 0));
    await guest.getByRole("link", { name: "下一页", exact: true }).click();
    await guest.getByRole("heading", { name: "网页第二页" }).waitFor();
    await page.getByRole("button", { name: "网页后退", exact: true }).click();
    await guest.getByRole("heading", { name: "实时网页" }).waitFor();
    await page.getByRole("button", { name: "网页前进", exact: true }).click();
    await guest.getByRole("heading", { name: "网页第二页" }).waitFor();
    expect(await readFile(join(vault, "Home.md"), "utf8")).toBe(saved);

    // 正文滚动只裁剪网页，不缩短网页自己的视口或覆盖应用工具栏。
    const scroll = page.locator(".main");
    await scroll.evaluate((element) => {
      const surface = element.querySelector(".webpage-surface");
      if (!surface) throw new Error("缺少网页区域");
      element.scrollTop +=
        surface.getBoundingClientRect().top - element.getBoundingClientRect().top + 80;
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const frame = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
            (view) => view.children.length > 0,
          );
          return frame?.children[0]?.getBounds().y;
        }),
      )
      .toBeLessThan(0);
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const frame = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
          (view) => view.children.length > 0,
        );
        return frame?.children[0]?.getBounds().height;
      }),
    ).toBe(360);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(guest.goto(`${origin}/offline`)).rejects.toThrow();
    await page
      .locator(".webpage-surface")
      .getByText(/网页加载失败/)
      .waitFor();
    offline = false;
    await page.getByRole("button", { name: "重新加载网页", exact: true }).click();
    await guest.getByRole("heading", { name: "实时网页" }).waitFor();
    await expect.poll(() => page.locator(".webpage-surface").textContent()).toBe("");

    const countViews = () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.contentView.children.filter(
            (view) => view.children.length > 0,
          ).length ?? 0,
      );
    expect(await countViews()).toBe(1);
    await page.locator(".ProseMirror h1").click();
    await command("insert-webpage");
    await dialog.waitFor();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]
            ?.contentView.children.filter((view) => view.children.length > 0)
            .some((view) => view.getVisible()),
        ),
      )
      .toBe(false);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]
            ?.contentView.children.filter((view) => view.children.length > 0)
            .some((view) => view.getVisible()),
        ),
      )
      .toBe(true);

    expect(
      await guest.evaluate(async () => {
        try {
          await fetch("noemori-vault://vault/Home.md");
          return "leaked";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .locator(".webpage-address")
      .getByText(/嵌入网页测试/)
      .waitFor();
    expect(await readFile(join(vault, "Home.md"), "utf8")).toBe(saved);
    await openLibrary(page);
    await page.getByRole("grid").getByRole("button", { name: "Other.md", exact: true }).dblclick();
    await page.getByRole("heading", { name: "其他笔记", exact: true }).waitFor();
    await expect.poll(countViews).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
