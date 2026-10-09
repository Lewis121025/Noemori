import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";
import { checkBudget } from "./budget";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("悬停首帧跟随与反向响应准确，跨控件复用几何且渲染开销有界", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-pointer-bench-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    state = join(root, "state"),
    library = join(root, "library");
  await Promise.all([mkdir(source), mkdir(state)]);
  await Promise.all([
    writeFile(join(source, "流畅.md"), "# Flow\n\n持续的反馈需要稳定的渲染。\n"),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({
        appearance: "light",
        reader: { vaultRoot: source, currentPath: "流畅.md" },
      }),
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
      NOEMORI_TEST_LIBRARY_ROOT: library,
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".ProseMirror").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const bar = page.locator(".topbar-document:not([hidden]) .formatting-panel");
    const first = (await bar.getByRole("button", { name: "段落格式", exact: true }).boundingBox())!;
    const last = (await bar.getByRole("button", { name: "行内代码", exact: true }).boundingBox())!;
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => {
      const value: { metrics: { name: string; value: number }[] } =
        await cdp.send("Performance.getMetrics");
      return value.metrics.find((metric) => metric.name === "LayoutCount")!.value;
    };
    const before = await metrics();
    const probe = await bar.evaluateHandle((node) => {
      const light = node.querySelector<HTMLElement>(":scope > .pointer-highlight");
      if (!light) throw new Error("缺少光标反馈表面");
      const body = light.querySelector<HTMLElement>(".pointer-body");
      if (!body) throw new Error("缺少光斑主体");
      const starts: { count: number; layout: boolean }[] = [];
      const samples: number[] = [];
      const errors: number[] = [];
      let previous = 0,
        frame = 0,
        response = 0,
        dropouts = 0,
        geometryReads = 0,
        wrongDirections = 0,
        pointer = 0,
        previousPointer = 0,
        previousCenter = 0,
        visible = node.hasAttribute("data-hover-visible");
      const original = light.animate;
      light.animate = function (frames, options) {
        if (!Array.isArray(frames)) throw new Error("悬停轨迹必须提供关键帧序列");
        starts.push({
          count: frames.length,
          layout: frames.some((value) => value.width !== undefined || value.height !== undefined),
        });
        return original.call(this, frames, options);
      };
      const controls = Array.from(node.querySelectorAll<HTMLElement>("button"));
      const measure = controls.map((control) => control.getBoundingClientRect);
      controls.forEach((control, index) => {
        control.getBoundingClientRect = function () {
          geometryReads += 1;
          return measure[index]!.call(this);
        };
      });
      const moved = (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        pointer = event.clientX;
        if (response) return;
        // 在动作注册帧之后采样：验收的是本次输入的第一帧，而非最终到达位置。
        response = requestAnimationFrame(() => {
          response = 0;
          const bounds = body.getBoundingClientRect();
          const center = bounds.left + bounds.width / 2;
          errors.push(Math.abs(center - pointer));
          if (previousPointer && (pointer - previousPointer) * (center - previousCenter) < -0.1)
            wrongDirections += 1;
          previousPointer = pointer;
          previousCenter = center;
        });
      };
      node.addEventListener("pointermove", moved);
      const observer = new MutationObserver(() => {
        const next = node.hasAttribute("data-hover-visible");
        if (visible && !next) dropouts += 1;
        visible = next;
      });
      observer.observe(node, { attributes: true, attributeFilter: ["data-hover-visible"] });
      frame = requestAnimationFrame(function sample(time) {
        if (previous) samples.push(time - previous);
        previous = time;
        frame = requestAnimationFrame(sample);
      });
      return {
        stop() {
          cancelAnimationFrame(frame);
          cancelAnimationFrame(response);
          observer.disconnect();
          node.removeEventListener("pointermove", moved);
          light.animate = original;
          controls.forEach((control, index) => {
            control.getBoundingClientRect = measure[index]!;
          });
          return { starts, samples, errors, dropouts, geometryReads, wrongDirections };
        },
      };
    });
    // 逐点扫过实际间隙和宽度不同的控件，不能只在按钮中心跳转来掩盖顿挫。
    const left = first.x + first.width / 2,
      right = last.x + last.width / 2;
    for (let round = 0; round < 3; round += 1) {
      for (let step = 0; step <= 80; step += 1) {
        const progress = round % 2 === 0 ? step / 80 : 1 - step / 80;
        await page.mouse.move(left + (right - left) * progress, first.y + first.height / 2);
        await page.waitForTimeout(8);
      }
    }
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const work = await probe.evaluate((probe) => probe.stop());
    await probe.dispose();
    const layouts = (await metrics()) - before;
    await cdp.detach();
    expect(work.dropouts).toBe(0);
    expect(work.errors.length).toBeGreaterThanOrEqual(30);
    expect(Math.max(...work.errors)).toBeLessThanOrEqual(0.5);
    expect(work.wrongDirections).toBe(0);
    expect(work.geometryReads).toBe(0);
    expect(work.starts.every((start) => !start.layout && start.count === 2)).toBe(true);
    // 光标运动只提交装饰层 transform，不能让控件或容器逐帧布局。
    expect(layouts).toBeLessThanOrEqual(3);
    await checkBudget("pointer-sweep-frame", work.samples, 32);
    console.info(
      JSON.stringify({
        scenario: "pointer-sweep-work",
        starts: work.starts.length,
        maxFirstFrameError: Math.max(...work.errors),
        wrongDirections: work.wrongDirections,
        geometryReads: work.geometryReads,
        dropouts: work.dropouts,
        layouts,
      }),
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
