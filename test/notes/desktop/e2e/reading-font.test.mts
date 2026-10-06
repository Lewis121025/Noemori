import { openSettings, sidebarComponent } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test.each(["目录跳转", "滚轮阅读"])("字体布局等待不能覆盖用户后续的%s", async (action) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-font-navigation-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(
    join(vault, "note.md"),
    Array.from(
      { length: 80 },
      (_, i) =>
        `## 第 ${i} 节\n\n` +
        "阅读，让思考慢下来。Good typography gives thought a place to rest. ".repeat(8),
    ).join("\n\n"),
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      readingFont: "lora",
      reader: { vaultRoot: vault, currentPath: "note.md", filesCollapsed: true, mode: "reading" },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const app = await electron.launch({
    executablePath,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${state}`,
      "--no-sandbox",
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    await page.locator(".ProseMirror").waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900),
    );
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "温润书页", exact: true, includeHidden: true })
          .isEnabled(),
      )
      .toBe(true);
    await sidebarComponent(page, "目录");
    await page.getByRole("button", { name: "第 20 节", exact: true }).click();
    // 控制异步边界，确保新的用户意图发生在字体已应用、布局尚未交接完成时。
    const release = await page.evaluateHandle(() => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.defineProperty(document.fonts, "ready", { configurable: true, get: () => ready });
      return () => {
        Reflect.deleteProperty(document.fonts, "ready");
        release();
      };
    });
    await openSettings(page);
    await page.getByRole("button", { name: "清晰现代", exact: true }).click();
    await expect
      .poll(() => page.locator(".ProseMirror").evaluate((el) => getComputedStyle(el).fontFamily))
      .toContain("Inter Variable");
    await page.keyboard.press("Escape");
    const scroller = page.locator(".main");
    if (action === "目录跳转") {
      await sidebarComponent(page, "目录");
      await page.getByRole("button", { name: "第 50 节", exact: true }).click();
      await expect
        .poll(async () => (await page.locator(".ProseMirror h2").nth(50).boundingBox())!.y)
        .toBeLessThan(130);
    } else {
      const top = await scroller.evaluate((el) => el.scrollTop);
      await scroller.hover({ position: { x: 400, y: 300 } });
      await page.mouse.wheel(0, 700);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top + 500);
    }
    const target = await scroller.evaluate((el) => el.scrollTop);
    await release.evaluate((release) => release());
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "清晰现代", exact: true, includeHidden: true })
          .isEnabled(),
      )
      .toBe(true);
    expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - target)).toBeLessThan(3);
    await release.dispose();
  } finally {
    await app.close();
  }
});

test("精选字体离线加载，切换保留双栏阅读位置、图文边界和源码，重启恢复选择", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-fonts-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const content =
    "# 阅读，让思考慢下来\n\nA little room for thought.\n\n![图文边界](wide.svg)\n\n```ts\nconst answer = 42;\n```\n\n" +
    Array.from({ length: 70 }, (_, i) =>
      `第 ${i} 段。Good typography gives thought a place to rest. 清晨的光落在纸上，让知识在回看中慢慢连成自己的地图。`.repeat(
        3,
      ),
    ).join("\n\n") +
    "\n";
  await writeFile(join(vault, "a.md"), content);
  await writeFile(join(vault, "b.md"), content);
  await writeFile(
    join(vault, "wide.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="120"><rect width="1400" height="120" fill="#ced7c6"/></svg>',
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      reader: {
        vaultRoot: vault,
        filesCollapsed: true,
        documents: {
          panes: ["a.md", "b.md"].map((currentPath) => ({
            currentPath,
            history: { back: [], forward: [] },
          })),
          active: 0,
          split: true,
        },
      },
    }),
  );
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron");
  const launch = () =>
    electron.launch({
      executablePath,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${state}`,
        "--no-sandbox",
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
        ),
      ),
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.context().setOffline(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900),
    );
    await expect.poll(() => page.locator(".ProseMirror").count()).toBe(2);
    await expect
      .poll(() =>
        page
          .locator(".ProseMirror")
          .first()
          .evaluate((el) => getComputedStyle(el).fontFamily),
      )
      .toContain("Lora Variable");
    await openSettings(page);
    // 建立阅读坐标基准前，先等侧栏宽度过渡与启动字体恢复完成。
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="阅读字体"]')?.getAttribute("aria-busy") === "false" &&
      document.querySelector(".file-sidebar")?.getAnimations().every((animation) => animation.playState === "finished"),
    );
    expect(
      await page.getByRole("group", { name: "阅读字体", exact: true }).getByRole("button").count(),
    ).toBe(3);
    for (const [label, latin, chinese] of [
      ["轻盈杂志", "Newsreader Variable", "Noto Serif SC Variable"],
      ["清晰现代", "Inter Variable", "Noto Sans SC Variable"],
      ["温润书页", "Lora Variable", "Noto Serif SC Variable"],
    ] as const) {
      const before = await page.locator(".ProseMirror").evaluateAll((editors) =>
        editors.map((editor) => {
          const anchor = editor.querySelectorAll(":scope > p")[25]!;
          const scroller = editor.closest(".main")!;
          scroller.scrollTop +=
            anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
          return anchor.getBoundingClientRect().top;
        }),
      );
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect
        .poll(() =>
          page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"),
        )
        .toBe("true");
      const metrics = await page.locator(".ProseMirror").evaluateAll((editors) =>
        editors.map((editor) => {
          const p = editor.querySelector(":scope > p")!;
          const image = editor.querySelector("img.note-image")!;
          return {
            font: getComputedStyle(editor).fontFamily,
            heading: getComputedStyle(editor.querySelector("h1")!).fontFamily,
            code: getComputedStyle(editor.querySelector("code")!).fontFamily,
            anchor: editor.querySelectorAll(":scope > p")[25]!.getBoundingClientRect().top,
            contained:
              image.getBoundingClientRect().left >= p.getBoundingClientRect().left - 1 &&
              image.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1,
          };
        }),
      );
      for (const [i, metric] of metrics.entries()) {
        expect(metric.font).toContain(latin);
        expect(metric.font).toContain(chinese);
        expect(metric.heading).toBe(metric.font);
        expect(metric.code).toContain("JetBrains Mono");
        expect(metric.contained).toBe(true);
        expect(Math.abs(metric.anchor - before[i]!)).toBeLessThan(3);
      }
      expect(
        await page.evaluate(
          async ([latin, chinese]) => {
            const fonts = await Promise.all([
              document.fonts.load(`400 17px "${latin}"`, "Reading"),
              document.fonts.load(`400 17px "${chinese}"`, "阅读"),
            ]);
            return fonts.every(
              (group) => group.length > 0 && group.every((font) => font.status === "loaded"),
            );
          },
          [latin, chinese],
        ),
      ).toBe(true);
    }
    const nextFont = page.getByRole("button", { name: "轻盈杂志", exact: true });
    await nextFont.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => nextFont.getAttribute("aria-pressed")).toBe("true");
    expect(await nextFont.evaluate((button) => document.activeElement === button)).toBe(true);
    await expect
      .poll(async () => JSON.parse(await readFile(join(state, "session.json"), "utf8")).readingFont)
      .toBe("newsreader");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.context().setOffline(true);
    await expect
      .poll(() =>
        page
          .locator(".ProseMirror")
          .first()
          .evaluate((el) => getComputedStyle(el).fontFamily),
      )
      .toContain("Newsreader Variable");
    expect(await readFile(join(vault, "a.md"), "utf8")).toBe(content);
    expect(await readFile(join(vault, "b.md"), "utf8")).toBe(content);
    const screenshots = process.env.NOEMORI_FONT_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await openSettings(page);
      await page.screenshot({ path: join(screenshots, "reading-fonts.png") });
    }
  } finally {
    await app.close();
  }
});
