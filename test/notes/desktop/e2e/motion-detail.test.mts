import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("选中底色连续移动，按压可撤销，目录折叠可反向且正文保持清晰", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-motion-detail-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source = "# 森林\n\n安静地阅读。\n\n## 林间\n\n保持连续。\n\n### 树影\n\n森林里的文字。\n";
  await Promise.all([
    writeFile(join(vault, "森林.md"), source),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ reader: { vaultRoot: vault, currentPath: "森林.md" } }),
    ),
  ]);
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
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".ProseMirror").waitFor();
    const original = await page.locator(".ProseMirror").elementHandle();
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState === "finished"),
    );
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await settings.hover();
    await page.mouse.down();
    try {
      expect(await settings.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await settings.evaluate((element) => getComputedStyle(element).scale)).toBe("none");
      await page.mouse.move(800, 500);
      await expect
        .poll(() => settings.evaluate((element) => getComputedStyle(element).boxShadow))
        .toBe("none");
    } finally {
      await page.mouse.up();
    }
    expect(await page.locator(".settings-window").getAttribute("open")).toBeNull();

    const bar = page.locator(".component-scroll[data-selection-ready]");
    await bar.waitFor();
    const indicatorX = () =>
      bar.evaluate((element) => Number.parseFloat(getComputedStyle(element, "::before").translate));
    const origin = await indicatorX();
    await bar.getByRole("button", { name: "搜索", exact: true }).click();
    const samples = await bar.evaluate(async (element) => {
      const values: number[] = [];
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise(requestAnimationFrame);
        values.push(Number.parseFloat(getComputedStyle(element, "::before").translate));
      }
      return values;
    });
    expect(samples.at(-1)).toBeGreaterThan(samples[0]!);
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    await expect.poll(indicatorX).toBeCloseTo(origin, 1);
    await page.keyboard.press("ArrowRight");
    expect(await indicatorX()).toBeCloseTo(origin, 1);
    await bar.getByRole("button", { name: "搜索", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() =>
        bar.evaluate((element) => {
          const selected = element.querySelector('[aria-pressed="true"]');
          if (!selected) throw new Error("缺少当前选择");
          const expected =
            selected.getBoundingClientRect().left -
            element.getBoundingClientRect().left +
            element.scrollLeft;
          return Number.parseFloat(getComputedStyle(element, "::before").translate) - expected;
        }),
      )
      .toBeCloseTo(0, 1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    await expect.poll(indicatorX).toBeCloseTo(origin, 1);

    const fold = page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "折叠", exact: true })
      .first();
    const kids = page.locator(".outline-sidebar nav > .kids");
    const height = await kids.evaluate((element) => element.getBoundingClientRect().height);
    await fold.click();
    // Svelte 先排入首帧再创建实际过渡，等待有时长的动画后才采样中间状态。
    await page.waitForFunction(() =>
      document
        .querySelector(".outline-sidebar nav > .kids")
        ?.getAnimations()
        .some((animation) => Number(animation.effect?.getTiming().duration) > 0),
    );
    const closing = await kids.evaluate((element) => {
      for (const animation of element.getAnimations()) {
        const duration = animation.effect?.getTiming().duration;
        if (typeof duration === "number") {
          animation.pause();
          animation.currentTime = duration * 0.45;
        }
      }
      return {
        height: element.getBoundingClientRect().height,
        inert: element instanceof HTMLElement && element.inert,
      };
    });
    expect(closing.height).toBeGreaterThan(0);
    expect(closing.height).toBeLessThan(height);
    expect(closing.inert).toBe(true);
    await page
      .locator(".outline-sidebar")
      .getByRole("button", { name: "展开", exact: true })
      .first()
      .click();
    await expect
      .poll(() => kids.evaluate((element) => element.getBoundingClientRect().height))
      .toBeCloseTo(height, 0);
    expect(await kids.evaluate((element) => element instanceof HTMLElement && element.inert)).toBe(
      false,
    );
    expect(
      await original?.evaluate((element) => element === document.querySelector(".ProseMirror")),
    ).toBe(true);
    await settings.click();
    await page.getByRole("button", { name: "绿色", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".app")?.getAttribute("data-reading-palette") === "green",
    );
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState === "finished"),
    );
    const firstPaletteFrame = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const app = document.querySelector(".app");
          if (!app) throw new Error("缺少应用根节点");
          const luminance = (color: string): number => {
            const values = color
              .match(/[\d.]+/g)
              ?.slice(0, 3)
              .map((channel) => {
                const value = Number(channel) / 255;
                return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
              });
            if (!values || values.length !== 3) throw new Error(`无法读取颜色：${color}`);
            return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
          };
          const observer = new MutationObserver(() => {
            if (app.getAttribute("data-reading-palette") !== "monochrome") return;
            observer.disconnect();
            requestAnimationFrame(() => {
              const nav = document.querySelector(".settings-window nav");
              const selected = nav?.querySelector('[aria-pressed="true"]');
              if (!nav || !selected) throw new Error("缺少设置分类");
              const foreground = luminance(getComputedStyle(selected).color);
              const background = luminance(getComputedStyle(nav).backgroundColor);
              resolve(
                (Math.max(foreground, background) + 0.05) /
                  (Math.min(foreground, background) + 0.05),
              );
            });
          });
          observer.observe(app, { attributes: true, attributeFilter: ["data-reading-palette"] });
        }),
    );
    await page.getByRole("button", { name: "黑白", exact: true }).click();
    expect(await firstPaletteFrame).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Escape");
    expect(await readFile(join(vault, "森林.md"), "utf8")).toBe(source);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
