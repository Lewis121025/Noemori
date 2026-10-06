import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { checkBudget } from "./budget";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("长文滚动、侧栏布局与底色样式更新有界", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-motion-bench-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 长文流畅度\n\n" +
    Array.from(
      { length: 250 },
      (_, index) =>
        `## 第 ${index} 节\n\n` +
        "森林中的阳光缓缓穿过树叶，阅读应当安静流畅。字体和段落保持清晰，侧栏开合不能干扰正在阅读的位置。This is a paragraph for measuring layout and reading performance.\n\n".repeat(
          4,
        ),
    ).join("");
  await Promise.all([
    writeFile(join(vault, "长文.md"), source),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ reader: { vaultRoot: vault, currentPath: "长文.md" } }),
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
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
        ),
      ),
      NOEMORI_TEST_WINDOW: "hidden",
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.locator(".ProseMirror").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const editor = await page.locator(".ProseMirror").elementHandle();
    await page.locator(".main").evaluate((element) => {
      element.scrollTop = 60000;
    });
    await page.waitForFunction(() => document.getAnimations().length === 0);
    // 先预热滚动与位置捕获，再按真实滚轮事件计数，避免用空闲帧掩盖线性扫描。
    await page.mouse.move(800, 400);
    for (let index = 0; index < 5; index += 1) await page.mouse.wheel(0, 100);
    const probe = await page.locator(".main").evaluateHandle((scroller) => {
      let measurements = 0;
      let scrolls = 0;
      let previous = 0;
      const samples: number[] = [];
      const nodes = Array.from(
        scroller.querySelectorAll<HTMLElement>(".ProseMirror :is(h1,h2,h3,h4,h5,h6)"),
      );
      const originals = nodes.map((node) => node.getBoundingClientRect);
      nodes.forEach((node, index) => {
        node.getBoundingClientRect = () => {
          measurements += 1;
          return originals[index]!.call(node);
        };
      });
      const onScroll = () => {
        scrolls += 1;
      };
      scroller.addEventListener("scroll", onScroll);
      let frame = requestAnimationFrame(function sample(time) {
        if (previous !== 0) samples.push(time - previous);
        previous = time;
        frame = requestAnimationFrame(sample);
      });
      return {
        stop() {
          cancelAnimationFrame(frame);
          scroller.removeEventListener("scroll", onScroll);
          nodes.forEach((node, index) => {
            node.getBoundingClientRect = originals[index]!;
          });
          return { measurements, scrolls, samples };
        },
      };
    });
    for (let index = 0; index < 40; index += 1) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(17);
    }
    const reading = await probe.evaluate((probe) => probe.stop());
    await probe.dispose();
    expect(reading.scrolls).toBeGreaterThan(0);
    expect(reading.measurements).toBeGreaterThan(0);
    expect(reading.measurements / reading.scrolls).toBeLessThanOrEqual(9);
    await checkBudget("long-document-scroll-frame", reading.samples, 32);

    const bar = page.locator(".component-scroll[data-selection-ready]");
    const mutations = await bar.evaluateHandle((element) => {
      let count = 0;
      const observer = new MutationObserver((records) => {
        count += records.length;
      });
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      return {
        stop() {
          observer.disconnect();
          return count;
        },
      };
    });
    for (let index = 0; index < 6; index += 1) {
      await bar
        .getByRole("button", { name: index % 2 === 0 ? "搜索" : "目录", exact: true })
        .click();
      await page.waitForFunction(() => document.getAnimations().length === 0);
    }
    const styleWrites = await mutations.evaluate((probe) => probe.stop());
    await mutations.dispose();
    expect(styleWrites).toBeLessThanOrEqual(24);
    const widths = await page.locator(".main").evaluateHandle((element) => {
      const values: number[] = [];
      const observer = new ResizeObserver(() => values.push(element.clientWidth));
      observer.observe(element);
      return {
        stop() {
          observer.disconnect();
          return values;
        },
      };
    });
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    await toggle.click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await toggle.click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const layoutWidths = await widths.evaluate((probe) => probe.stop());
    await widths.dispose();
    expect(new Set(layoutWidths).size).toBeLessThanOrEqual(2);
    expect(
      await editor?.evaluate((element) => element === document.querySelector(".ProseMirror")),
    ).toBe(true);
    console.info(
      JSON.stringify({
        scenario: "motion-work",
        headingReadsPerScroll: reading.measurements / reading.scrolls,
        selectionStyleWrites: styleWrites,
        sidebarLayoutWidths: new Set(layoutWidths).size,
      }),
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
