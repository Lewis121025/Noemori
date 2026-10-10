import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";
import { _electron as electron, type Page } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

async function launch(t: TestContext, debugDragRegions = false) {
  const root = await mkdtemp(join(tmpdir(), "noemori-flow-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const library = join(root, "library");
  const state = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(state)]);
  const source =
    "# 流动\n\n连续地阅读和书写。\n\n## 连接\n\n保持当前的注意力。\n" +
    Array.from(
      { length: 120 },
      (_, index) => `\n## 片段 ${index}\n\n${"长文中的注意力与编辑位置保持连续。".repeat(4)}\n`,
    ).join("");
  await Promise.all([
    writeFile(join(vault, "流动.md"), source),
    writeFile(
      join(state, "session.json"),
      JSON.stringify({ appearance: "light", reader: { vaultRoot: vault, currentPath: "流动.md" } }),
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
      Object.entries({
        ...process.env,
        NOEMORI_TEST_LIBRARY_ROOT: library,
        ...(debugDragRegions
          ? { ELECTRON_DEBUG_DRAGGABLE_REGIONS: "1", ELECTRON_ENABLE_LOGGING: "1" }
          : {}),
      }).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
      ),
    ),
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.onTestFinished(() => expect(errors).toEqual([]));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".ProseMirror").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  return { app, page, vault: join(library, "vault"), source };
}

async function sampleLayout(page: Page, trigger: () => Promise<void>) {
  const [frames] = await Promise.all([
    page.locator(".document-body").evaluate(async (body) => {
      const values: { left: number; width: number }[] = [];
      const scroller = body.closest(".main");
      if (!(scroller instanceof HTMLElement)) throw new Error("缺少滚动区");
      for (let frame = 0; frame < 24; frame += 1) {
        await new Promise(requestAnimationFrame);
        values.push({ left: body.getBoundingClientRect().left, width: scroller.clientWidth });
      }
      return values;
    }),
    trigger(),
  ]);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const destination = await page
    .locator(".document-body")
    .evaluate((body) => body.getBoundingClientRect().left);
  const direction = Math.sign(destination - frames[0]!.left);
  expect(direction).not.toBe(0);
  // 整段轨迹只能朝终点前进，不能先闪到终点再拉回动画起点。
  for (let index = 1; index < frames.length; index += 1)
    expect((frames[index]!.left - frames[index - 1]!.left) * direction).toBeGreaterThanOrEqual(
      -0.5,
    );
  expect(new Set(frames.map((frame) => frame.width)).size).toBeLessThanOrEqual(2);
}

async function entryOffset(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((node) => {
    const effect = node.getAnimations()[0]?.effect;
    if (!(effect instanceof KeyframeEffect)) throw new Error("缺少内容衔接动效");
    return Number.parseFloat(String(effect.getKeyframes()[0]?.translate));
  });
}

async function pauseNextMotion(page: Page, selector: string, trigger: () => Promise<void>) {
  // 在输入前开始观察，捕获首帧；测试进程繁忙时也不会错过短动效。
  await Promise.all([
    page.locator(selector).evaluate(async (node) => {
      const previous = new Set(node.getAnimations({ subtree: true }));
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise(requestAnimationFrame);
        const motion = node
          .getAnimations({ subtree: true })
          .find(
            (candidate) =>
              !previous.has(candidate) &&
              candidate.effect instanceof KeyframeEffect &&
              candidate.effect.getKeyframes().some((frame) => frame.translate !== undefined),
          );
        if (motion) {
          motion.pause();
          return;
        }
      }
      throw new Error("展示状态改变后未产生衔接动效");
    }),
    trigger(),
  ]);
}

test("左右侧栏衔接正文真实位置，首次绘制不闪回且长文不逐帧重排", async (t) => {
  const { app, page, vault, source } = await launch(t);
  try {
    const editor = await page.locator(".ProseMirror").elementHandle();
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    await sampleLayout(page, () => toggle.click());
    await sampleLayout(page, () => toggle.click());
    await sampleLayout(page, () =>
      page.getByRole("button", { name: "工作区助手", exact: true }).click(),
    );
    await sampleLayout(page, () =>
      page.getByRole("button", { name: "关闭助手", exact: true }).click(),
    );
    expect(await editor?.evaluate((node) => node === document.querySelector(".ProseMirror"))).toBe(
      true,
    );
    expect(
      await page.locator(".ProseMirror").evaluate((node) => getComputedStyle(node).scale),
    ).toBe("none");
    expect(await readFile(join(vault, "流动.md"), "utf8")).toBe(source);
  } finally {
    await app.close();
  }
});

test("快速反向接续当前位置，减少动态效果和覆盖式助手立即对齐", async (t) => {
  const { app, page } = await launch(t);
  try {
    const toggle = page.getByRole("button", { name: "显示或隐藏文件栏", exact: true });
    await toggle.click();
    const before = await page.locator(".pane-content").evaluate((node) => {
      const animation = node.getAnimations()[0];
      if (!animation) throw new Error("缺少布局动效");
      animation.pause();
      animation.currentTime = 80;
      return node.querySelector(".document-body")!.getBoundingClientRect().left;
    });
    await toggle.click();
    const after = await page.locator(".pane-content").evaluate((node) => {
      const animation = node.getAnimations()[0];
      if (!animation) throw new Error("缺少反向动效");
      animation.pause();
      animation.currentTime = 0;
      return node.querySelector(".document-body")!.getBoundingClientRect().left;
    });
    expect(after).toBeCloseTo(before, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.locator(".pane-content").evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(900, 720),
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const origin = await page
      .locator(".document-body")
      .evaluate((node) => node.getBoundingClientRect().left);
    await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    expect(
      await page.locator(".pane-content").evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    expect(
      await page.locator(".document-body").evaluate((node) => node.getBoundingClientRect().left),
    ).toBe(origin);
  } finally {
    await app.close();
  }
});

test("目录与设置按导航方向衔接，关闭设置回到原操作位置", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    expect(await entryOffset(page, ".outline-content")).toBe(8);
    expect(await page.locator(".library").evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await settings.click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    expect(await entryOffset(page, ".settings-content")).toBe(8);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.getByRole("button", { name: "外观与阅读", exact: true }).click();
    expect(await entryOffset(page, ".settings-content")).toBe(-8);
    await page.keyboard.press("Escape");
    expect(await settings.evaluate((node) => document.activeElement === node)).toBe(true);
  } finally {
    await app.close();
  }
});

test("设置分类中途切回接续当前位置与速度", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const content = page.locator(".settings-content");
    await pauseNextMotion(page, ".settings-content", () =>
      page.getByRole("button", { name: "快捷键", exact: true }).click(),
    );
    const before = await content.evaluate((node) => {
      const motion = node.getAnimations({ subtree: true })[0]!;
      motion.pause();
      const x = (time: number) => {
        motion.currentTime = time;
        return Number.parseFloat(getComputedStyle(node).translate);
      };
      const left = x(73),
        right = x(77);
      return { position: x(75), velocity: (right - left) / 0.004 };
    });
    await pauseNextMotion(page, ".settings-content", () =>
      page.getByRole("button", { name: "外观与阅读", exact: true }).click(),
    );
    const after = await content.evaluate((node) => {
      const motion = node.getAnimations()[0]!;
      motion.pause();
      motion.currentTime = 0;
      const position = Number.parseFloat(getComputedStyle(node).translate);
      motion.currentTime = 4;
      const next = Number.parseFloat(getComputedStyle(node).translate);
      motion.finish();
      return { position, velocity: (next - position) / 0.004 };
    });
    expect(after.position).toBeCloseTo(before.position, 1);
    expect(Math.abs(after.velocity - before.velocity)).toBeLessThan(
      Math.abs(before.velocity) * 0.15,
    );
  } finally {
    await app.close();
  }
});

test("子菜单斜向移动穿过相邻菜单项时保持打开，停留相邻项仍可切换", async (t) => {
  const { app, page } = await launch(t);
  try {
    await page.getByRole("button", { name: "段落格式", exact: true }).click();
    const titles = page.getByRole("menuitem", { name: "标题", exact: true });
    await titles.hover();
    const submenu = page.locator('.submenu[aria-label="标题"]');
    await submenu.waitFor();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const from = (await titles.boundingBox())!;
    const to = (await submenu
      .getByRole("menuitemradio", { name: "标题 4", exact: true })
      .boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.move(to.x + 12, to.y + to.height / 2, { steps: 12 });
    expect(await submenu.evaluate((node) => node.matches(":popover-open"))).toBe(true);
    await titles.hover();
    await page.getByRole("menuitemradio", { name: "代码块", exact: true }).hover();
    await expect.poll(() => submenu.evaluate((node) => node.matches(":popover-open"))).toBe(false);
  } finally {
    await app.close();
  }
});

test("菜单悬停等待由键盘接管，关闭重开不遗留切换任务", async (t) => {
  const { app, page } = await launch(t);
  try {
    const trigger = page.getByRole("button", { name: "段落格式", exact: true });
    const titles = page.getByRole("menuitem", { name: "标题", exact: true });
    const submenu = page.locator('.submenu[aria-label="标题"]');
    const approachNeighbour = async () => {
      await titles.hover();
      await page.waitForFunction(() => document.getAnimations().length === 0);
      const code = (await page
        .getByRole("menuitemradio", { name: "代码块", exact: true })
        .boundingBox())!;
      await page.mouse.move(code.x + code.width - 8, code.y + code.height / 2, { steps: 6 });
      expect(await submenu.evaluate((node) => node.matches(":popover-open"))).toBe(true);
    };
    await trigger.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await approachNeighbour();
    await page.keyboard.press("ArrowRight");
    expect(
      await submenu
        .getByRole("menuitemradio", { name: "标题 2", exact: true })
        .evaluate((node) => document.activeElement === node),
    ).toBe(true);
    await page.waitForTimeout(230);
    expect(await submenu.evaluate((node) => node.matches(":popover-open"))).toBe(true);
    await page.keyboard.press("Escape");
    expect(await titles.evaluate((node) => document.activeElement === node)).toBe(true);
    await approachNeighbour();
    await page.keyboard.press("Escape");
    expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(230);
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await submenu.evaluate((node) => node.matches(":popover-open"))).toBe(false);
  } finally {
    await app.close();
  }
});

test("表格对齐底色移动且减少动态效果立即对齐，预览与取消不修改正文", async (t) => {
  const { app, page, vault, source } = await launch(t);
  try {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "表格…", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "插入表格", exact: true });
    const alignment = picker.locator('[aria-label="列对齐"][data-selection-ready]');
    await alignment.waitFor();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const origin = await alignment.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node, "::before").translate),
    );
    await pauseNextMotion(page, '[aria-label="列对齐"]', () =>
      picker.getByRole("button", { name: "右对齐", exact: true }).click(),
    );
    const partial = await alignment.evaluate((node) => {
      const motion = node.getAnimations({ subtree: true })[0]!;
      motion.pause();
      motion.currentTime = 75;
      return {
        x: Number.parseFloat(getComputedStyle(node, "::before").translate),
        destination: Number.parseFloat(node.style.getPropertyValue("--selection-x")),
      };
    });
    expect(partial.x).toBeGreaterThan(origin);
    expect(partial.x).toBeLessThan(partial.destination);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() => alignment.evaluate((node) => node.getAnimations({ subtree: true }).length))
      .toBe(0);
    expect(
      await alignment.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node, "::before").translate),
      ),
    ).toBeCloseTo(partial.destination, 1);
    await picker.locator('[data-table-rows="4"][data-table-columns="5"]').hover();
    expect(await picker.locator("output").textContent()).toBe("5 列 × 4 行");
    expect(
      await picker
        .locator(".table-size-picker span")
        .first()
        .evaluate((node) =>
          getComputedStyle(node)
            .transitionDuration.split(",")
            .every((value) => Number.parseFloat(value) === 0),
        ),
    ).toBe(true);
    await picker.getByRole("button", { name: "取消插入表格", exact: true }).click();
    expect(await page.locator(".ProseMirror table").count()).toBe(0);
    expect(await readFile(join(vault, "流动.md"), "utf8")).toBe(source);
  } finally {
    await app.close();
  }
});

// 当前只有 macOS 使用自绘标题栏；其他平台的系统窗框会忽略应用声明的拖动区域。
test.skipIf(process.platform !== "darwin")("顶栏内容与伪元素的增删和移动不改变 Electron 原生命中区域", async (t) => {
  const { app, page } = await launch(t, true);
  let output = "";
  const record = (chunk: Buffer) => (output += chunk.toString());
  const stderr = app.process().stderr;
  if (!stderr) throw new Error("缺少 Electron 原生拖动区域诊断输出");
  stderr.on("data", record);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const stage of ["baseline", "append", "move", "remove"] as const) {
      const offset = output.length;
      await page.evaluate((stage) => {
        const toolbar = document.querySelector(".window-toolbar");
        const group = toolbar?.querySelector(".window-actions");
        const button = group?.querySelector(".agent-entry");
        if (!toolbar || !group || !button) throw new Error("缺少顶栏 Agent 入口");
        if (stage === "baseline") {
          // 在按钮内部添加已被排除的小区域，强制原生端回报，避免把没有日志误判为成功。
          const witness = document.createElement("div");
          witness.id = "drag-region-witness";
          witness.style.cssText =
            "position:absolute;width:1px;height:1px;pointer-events:none;app-region:no-drag";
          button.append(witness);
        } else if (stage === "append") {
          const decoration = document.createElement("div");
          decoration.id = "drag-region-decoration";
          decoration.style.cssText =
            "position:absolute;inset:-6px;pointer-events:none;opacity:0;z-index:-1";
          group.append(decoration);
          const style = document.createElement("style");
          style.id = "drag-region-pseudo";
          style.textContent =
            '.window-toolbar::after { content: ""; position: absolute; inset: -6px; pointer-events: none; opacity: 0; }';
          document.head.append(style);
        } else if (stage === "move") {
          const decoration = document.getElementById("drag-region-decoration");
          if (!decoration) throw new Error("缺少拖动区域测试装饰");
          decoration.style.transform = "translateX(-80px) scale(1.3)";
        } else {
          document.getElementById("drag-region-decoration")?.remove();
          document.getElementById("drag-region-pseudo")?.remove();
        }
        const witness = document.getElementById("drag-region-witness");
        if (!witness) throw new Error("缺少原生区域回报触发器");
        witness.style.width = `${["baseline", "append", "move", "remove"].indexOf(stage) + 1}px`;
      }, stage);
      const updates = () => output
        .slice(offset)
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.includes("hit-test region computed"));
      await expect.poll(() => updates().length).toBeGreaterThan(0);
      for (const update of updates())
        expect(update, `${stage} 不得改变原生可拖动区域的任何一点`).toContain(
          "identical to previous region",
        );
    }
  } finally {
    stderr.off("data", record);
    await app.close();
  }
});

test("顶栏 Agent 与文件栏的悬停装饰不进入原生拖动区域，图标和文字均可切换侧栏", async (t) => {
  const { app, page } = await launch(t);
  try {
    const toolbar = page.locator(".window-toolbar");
    expect(
      await toolbar.evaluate((node) => getComputedStyle(node).getPropertyValue("app-region")),
    ).toBe("drag");
    const toggles = [
      {
        button: toolbar.getByRole("button", { name: "工作区助手", exact: true }),
        group: toolbar.locator(".window-actions"),
        sidebar: page.locator(".file-sidebar.right"),
      },
      {
        button: toolbar.getByRole("button", { name: "显示或隐藏文件栏", exact: true }),
        group: toolbar.locator(".window-navigation"),
        sidebar: page.locator(".file-sidebar:not(.right)"),
      },
    ];
    for (const { button, group, sidebar } of toggles) {
      for (const target of [button.locator("svg"), button.locator("span"), button]) {
        if (!(await target.count())) continue;
        await target.hover();
        await expect.poll(() => group.getAttribute("data-hover-visible")).toBe("");
        expect(
          await group.evaluate((node) => getComputedStyle(node).getPropertyValue("app-region")),
        ).toBe("none");
        expect(
          await button.evaluate((node) => getComputedStyle(node).getPropertyValue("app-region")),
        ).toBe("no-drag");
        // CDP 点击绕过系统标题栏命中；光斑必须不产生区域，既不覆盖按钮，也不扣掉空白拖动区。
        expect(
          await group.locator(".pointer-highlight, .pointer-highlight > *").evaluateAll((nodes) =>
            nodes.map((node) => ({
              region: getComputedStyle(node).getPropertyValue("app-region"),
              pointer: getComputedStyle(node).pointerEvents,
            })),
          ),
        ).toEqual(Array.from({ length: 3 }, () => ({ region: "none", pointer: "none" })));
        const expanded = (await button.getAttribute("aria-expanded")) === "true";
        await target.click();
        await expect.poll(() => button.getAttribute("aria-expanded")).toBe(String(!expanded));
        await expect
          .poll(() => sidebar.evaluate((node) => node.hasAttribute("hidden")))
          .toBe(expanded);
      }
    }
  } finally {
    await app.close();
  }
});

test("光标在控件内移动和急转时首帧跟随，键盘与减少动态效果立即接管", async (t) => {
  const { app, page, vault, source } = await launch(t);
  try {
    const editor = page.locator(".ProseMirror");
    await editor.click();
    const toolbar = page.locator(".topbar-document:not([hidden]) .formatting-panel");
    const bold = toolbar.getByRole("button", { name: "加粗", exact: true });
    const strike = toolbar.getByRole("button", { name: "删除线", exact: true });
    const initial = (await bold.boundingBox())!;
    const far = (await strike.boundingBox())!;
    const sample = async (x: number) => {
      await page.mouse.move(x, initial.y + initial.height / 2);
      return toolbar.evaluate(async (node) => {
        await new Promise(requestAnimationFrame);
        const highlight = node.querySelector<HTMLElement>(
          ":scope > .pointer-highlight > .pointer-body",
        );
        if (!highlight) throw new Error("缺少光标反馈表面");
        const bounds = highlight.getBoundingClientRect();
        return bounds.left + bounds.width / 2;
      });
    };
    for (const x of [
      initial.x + 5,
      initial.x + initial.width - 5,
      far.x + far.width / 2,
      initial.x + 5,
    ])
      expect(await sample(x)).toBeCloseTo(x, 0);
    expect(await bold.boundingBox()).toEqual(initial);
    expect(await editor.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.waitForTimeout(60);
    const resting = await toolbar.evaluate(async (node) => {
      const light = node.querySelector<HTMLElement>(":scope > .pointer-highlight");
      if (!light) throw new Error("缺少光标反馈表面");
      const frames: { center: number; width: number }[] = [];
      for (let index = 0; index < 72; index += 1) {
        await new Promise(requestAnimationFrame);
        const bounds = light.getBoundingClientRect();
        frames.push({ center: bounds.left + bounds.width / 2, width: bounds.width });
      }
      let writes = 0;
      const observer = new MutationObserver((records) => (writes += records.length));
      observer.observe(light, { attributes: true, subtree: true, attributeFilter: ["style"] });
      for (let index = 0; index < 6; index += 1) await new Promise(requestAnimationFrame);
      observer.disconnect();
      return { frames, writes };
    });
    for (let index = 0; index < resting.frames.length; index += 1) {
      expect(resting.frames[index]!.center).toBeCloseTo(initial.x + 5, 0);
      expect(resting.frames[index]!.width).toBeGreaterThan(0);
      expect(resting.frames[index]!.width).toBeLessThanOrEqual(resting.frames[0]!.width * 1.12);
    }
    expect(resting.writes).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await sample(far.x + far.width / 2)).toBeCloseTo(far.x + far.width / 2, 0);
    await expect
      .poll(() => toolbar.evaluate((node) => node.getAnimations({ subtree: true }).length))
      .toBe(0);
    await page.keyboard.press("Tab");
    await expect.poll(() => toolbar.getAttribute("data-hover-visible")).toBeNull();
    await page.mouse.move(1000, 600);
    expect(await readFile(join(vault, "流动.md"), "utf8")).toBe(source);
  } finally {
    await app.close();
  }
});

test("菜单与文件列表独立接住光标，关闭、滚动和虚拟项移除后不残留底色", async (t) => {
  const { app, page, vault } = await launch(t);
  try {
    await page.getByRole("button", { name: "段落格式", exact: true }).click();
    const menu = page.getByRole("menu", { name: "段落格式", exact: true });
    await menu.getByRole("menuitemradio", { name: "正文", exact: true }).hover();
    await expect.poll(() => menu.getAttribute("data-hover-visible")).toBe("");
    await page.getByRole("menuitem", { name: "标题", exact: true }).hover();
    const submenu = page.getByRole("menu", { name: "标题", exact: true });
    await submenu.getByRole("menuitemradio", { name: "标题 4", exact: true }).hover();
    await expect.poll(() => submenu.getAttribute("data-hover-visible")).toBe("");
    expect(await menu.getAttribute("data-hover-visible")).toBeNull();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(() => submenu.getAttribute("data-hover-visible")).toBeNull();
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(vault, `片段${String(index).padStart(2, "0")}.md`), "连续阅读。\n"),
      ),
    );
    const tree = page.locator(".file-tree");
    const folder = tree.getByRole("button", { name: "vault", exact: true });
    if (!(await tree.getByRole("button", { name: "片段01.md", exact: true }).count()))
      await folder.click();
    const entry = tree.getByRole("button", { name: "片段01.md", exact: true });
    await entry.waitFor();
    await entry.hover();
    await expect.poll(() => tree.getAttribute("data-hover-visible")).toBe("");
    await page.mouse.wheel(0, 700);
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        tree.evaluate((node) => {
          if (!node.hasAttribute("data-hover-visible")) return true;
          // 原生悬停可接住滚动后的新行，但高亮不能留在旧行的视口位置。
          const row = node.querySelector("button[data-path]:hover")?.closest("[data-hover-target]");
          if (!row) return false;
          const highlight = node.querySelector(":scope > .pointer-highlight");
          if (!highlight) return false;
          const bounds = highlight.getBoundingClientRect();
          const target = row.getBoundingClientRect();
          return (
            Math.abs(bounds.top + bounds.height / 2 - (target.top + target.height / 2)) <
            target.height / 2 + 0.2
          );
        }),
      )
      .toBe(true);
    const visible = tree.locator("button[data-path]").first();
    await visible.hover();
    const bounds = (await visible.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2 + 2, bounds.y + bounds.height / 2 + 2);
    await expect.poll(() => tree.getAttribute("data-hover-visible")).toBe("");
    await page.getByRole("searchbox", { name: "搜索笔记库", exact: true }).fill("流动");
    await expect.poll(() => tree.locator('button[data-path$=".md"]').count()).toBe(1);
    await expect.poll(() => tree.getAttribute("data-hover-visible")).toBeNull();
  } finally {
    await app.close();
  }
});

test("键盘开合侧栏保留正文输入，只有收起焦点所在区域才交还入口", async (t) => {
  const { app, page } = await launch(t);
  try {
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.type("继续书写");
    expect(await editor.innerText()).toContain("继续书写");
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.getByRole("searchbox", { name: "搜索笔记库", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Backslash");
    expect(
      await page
        .getByRole("button", { name: "显示或隐藏文件栏", exact: true })
        .evaluate((node) => document.activeElement === node),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("文件大纲指示底色接续反向操作，拖动分隔条可取消并继续键盘调整", async (t) => {
  const { app, page } = await launch(t);
  try {
    const tabs = page.locator(".panel-switch[data-selection-ready]");
    await tabs.waitFor();
    const origin = await tabs.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node, "::before").translate),
    );
    await page.getByRole("button", { name: "文章大纲", exact: true }).click();
    // 按钮颜色过渡可先于底色启动，只有伪元素动画能证明导航底色已接续。
    await page.waitForFunction(() =>
      document
        .querySelector(".panel-switch")
        ?.getAnimations({ subtree: true })
        .some((motion) =>
          motion.effect instanceof KeyframeEffect && motion.effect.pseudoElement === "::before"),
    );
    const interrupted = await tabs.evaluate((node) => {
      for (const motion of node.getAnimations({ subtree: true })) {
        if (!(motion.effect instanceof KeyframeEffect) || motion.effect.pseudoElement !== "::before")
          continue;
        motion.pause();
        motion.currentTime = 75;
        motion.id = "interrupted-tab";
      }
      return Number.parseFloat(getComputedStyle(node, "::before").translate);
    });
    expect(interrupted).toBeGreaterThan(origin);
    await page.getByRole("button", { name: "文件目录", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector(".panel-switch")
        ?.getAnimations({ subtree: true })
        .some((motion) => motion.id !== "interrupted-tab" &&
          motion.effect instanceof KeyframeEffect && motion.effect.pseudoElement === "::before"),
    );
    const resumed = await tabs.evaluate((node) => {
      for (const motion of node.getAnimations({ subtree: true })) {
        if (!(motion.effect instanceof KeyframeEffect) || motion.effect.pseudoElement !== "::before")
          continue;
        motion.pause();
        motion.currentTime = 0;
      }
      return Number.parseFloat(getComputedStyle(node, "::before").translate);
    });
    expect(resumed).toBeCloseTo(interrupted, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() =>
        tabs.evaluate((node) => Number.parseFloat(getComputedStyle(node, "::before").translate)),
      )
      .toBeCloseTo(origin, 1);
    const indicatorBounds = await tabs.evaluate((node) => {
      const selected = node.querySelector('button[aria-pressed="true"]')!;
      const indicator = getComputedStyle(node, "::before");
      const bounds = selected.getBoundingClientRect();
      return {
        width: Number.parseFloat(indicator.width),
        height: Number.parseFloat(indicator.height),
        selectedWidth: bounds.width,
        selectedHeight: bounds.height,
      };
    });
    expect(indicatorBounds.width).toBeCloseTo(indicatorBounds.selectedWidth, 1);
    expect(indicatorBounds.height).toBeCloseTo(indicatorBounds.selectedHeight, 1);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    const handle = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
    const initial = Number(await handle.getAttribute("aria-valuenow"));
    const bounds = await handle.boundingBox();
    if (!bounds) throw new Error("缺少侧栏分隔条");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 54, bounds.y + 120);
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(initial + 40);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(initial);
    expect(await handle.evaluate((node) => document.activeElement === node)).toBe(true);
    await page.keyboard.press("ArrowRight");
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(initial + 10);

    await page.getByRole("button", { name: "双链", exact: true }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const heightHandle = page.getByRole("separator", { name: "调整双链高度", exact: true });
    const height = Number(await heightHandle.getAttribute("aria-valuenow"));
    const heightBounds = await heightHandle.boundingBox();
    if (!heightBounds) throw new Error("缺少双链分隔条");
    await page.mouse.move(heightBounds.x + 70, heightBounds.y + heightBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(heightBounds.x + 70, heightBounds.y - 45);
    expect(Number(await heightHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(height);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(Number(await heightHandle.getAttribute("aria-valuenow"))).toBe(height);
  } finally {
    await app.close();
  }
});
