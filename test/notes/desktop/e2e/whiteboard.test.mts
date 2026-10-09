import { confirmNewEntry, newEntry } from "../support/workspace-actions";
import { documentTools, sidebarComponent } from "../support/workspace-actions";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("白板模式与工具栏：正文插入、手势编辑、保存重启、改名和嵌入关系", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-whiteboard-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await writeFile(join(vault, "Home.md"), "# 思考\n\n记录位置\n\n保留后文\n");
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "Home.md", filesCollapsed: true, leftWidth: 232 },
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
  const command = async (application: ElectronApplication, id: string) => {
    await application.evaluate(({ Menu }, action) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(action);
      if (!item || !item.enabled) throw new Error(`命令不可用：${action}`);
      item.click();
    }, id);
  };
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".ProseMirror").first().getByText("记录位置", { exact: true }).click();
    await command(app, "insert-whiteboard");
    await page
      .getByRole("button", { name: "打开白板 attachments/白板.noemoriboard", exact: true })
      .waitFor();
    await expect
      .poll(() => readFile(join(vault, "Home.md"), "utf8"), { timeout: 8000 })
      .toContain("![[attachments/白板.noemoriboard]]");
    await page
      .getByRole("button", { name: "打开白板 attachments/白板.noemoriboard", exact: true })
      .click();
    const board = page.getByRole("application", { name: "白板", exact: true });
    await board.waitFor();
    const box = await board.boundingBox();
    if (!box || box.width < 600 || box.height < 360) throw new Error("白板没有填满编辑区");
    const initialCamera = await page
      .locator(".whiteboard .board-canvas > g")
      .getAttribute("transform");
    const draw = async (points: readonly (readonly [number, number])[], hold = false) => {
      const first = points[0]!;
      await page.mouse.move(box.x + first[0], box.y + first[1]);
      await page.mouse.down();
      for (const [x, y] of points.slice(1))
        await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
      if (hold) {
        try {
          await page.locator(".whiteboard .pending.corrected").waitFor({ timeout: 5000 });
        } catch (cause) {
          throw new Error(
            `停笔没有生成预览：${(await page.locator(".whiteboard .error").allTextContents()).join("；")}；${String(cause)}`,
          );
        }
      }
      await page.mouse.up();
    };
    await draw([
      [140, 150],
      [200, 180],
      [270, 150],
    ]);
    await draw([
      [220, 210],
      [220, 290],
    ]);
    await draw([
      [500, 160],
      [540, 200],
      [500, 240],
    ]);
    const strokes = page.locator(".whiteboard [data-stroke-id]");
    await expect.poll(() => strokes.count()).toBe(3);
    expect(await page.locator(".whiteboard .board-canvas > g").getAttribute("transform")).toBe(
      initialCamera,
    );
    const before = await strokes.evaluateAll((items) =>
      items.map((item) => item.getAttribute("d")),
    );
    await draw(
      [
        [90, 90],
        [340, 90],
        [340, 330],
        [90, 330],
        [90, 90],
      ],
      true,
    );
    expect(await page.locator(".whiteboard path.selected").count()).toBe(0);
    expect(await strokes.count()).toBe(4);
    await command(app, "undo");
    await expect.poll(() => strokes.count()).toBe(3);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    expect(await page.locator(".whiteboard path.selected").count()).toBe(3);
    await draw([
      [200, 200],
      [260, 240],
    ]);
    expect(await strokes.first().getAttribute("d")).not.toBe(before[0]);
    await command(app, "undo");
    await expect.poll(() => strokes.first().getAttribute("d")).toBe(before[0]);
    await draw([
      [180, 215],
      [270, 225],
      [180, 240],
      [270, 255],
      [180, 270],
      [270, 285],
    ]);
    await expect.poll(() => strokes.count()).toBe(2);
    await command(app, "undo");
    await expect.poll(() => strokes.count()).toBe(3);
    await command(app, "redo");
    await expect.poll(() => strokes.count()).toBe(2);
    await command(app, "undo");
    await expect.poll(() => strokes.count()).toBe(3);
    const transform = await page.locator(".whiteboard .board-canvas > g").getAttribute("transform");
    await page.mouse.wheel(40, 50);
    await expect
      .poll(() => page.locator(".whiteboard .board-canvas > g").getAttribute("transform"))
      .not.toBe(transform);
    const boardPath = join(vault, "attachments", "白板.noemoriboard");
    await command(app, "save");
    await expect
      .poll(async () => JSON.parse(await readFile(boardPath, "utf8")).strokes.length, {
        timeout: 8000,
      })
      .toBe(3);
    const saved = await readFile(boardPath, "utf8");
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("application", { name: "白板", exact: true }).waitFor();
    await expect.poll(() => page.locator(".whiteboard [data-stroke-id]").count()).toBe(3);
    expect(await readFile(boardPath, "utf8")).toBe(saved);
    if (!(await page.locator(".file-sidebar:not(.right)").isVisible()))
      await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    await documentTools(page);
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    await page.getByRole("button", { name: "重命名…", exact: true }).click();
    await page.locator("#entry-name").fill("整理.noemoriboard");
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await expect
      .poll(() => readFile(join(vault, "Home.md"), "utf8"), { timeout: 8000 })
      .toContain("整理.noemoriboard");
    // 正文链接已落盘还不代表异步重命名的会话迁移和界面重载已完成。
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await command(app, "go-back");
    await page
      .getByRole("button", { name: "打开白板 attachments/整理.noemoriboard", exact: true })
      .waitFor();
    expect(await page.locator(".whiteboard-preview path").count()).toBe(3);
    expect(await readFile(join(vault, "Home.md"), "utf8")).toContain("保留后文");
    await sidebarComponent(page, "文件系统");
    await page.locator(".root-label").click();
    await newEntry(page, "白板");
    await confirmNewEntry(page);
    await page.getByRole("application", { name: "白板", exact: true }).waitFor();
    await documentTools(page);
    await page.getByRole("toolbar", { name: "白板编辑工具栏", exact: true }).waitFor();
    expect(await page.locator(".mode-switch").count()).toBe(0);
    expect(await page.locator(".whiteboard [data-stroke-id]").count()).toBe(0);
    // 停笔预览规范直线，抬笔提交修复轮廓且可整体撤销。
    const inputBox = await page
      .getByRole("application", { name: "白板", exact: true })
      .boundingBox();
    if (!inputBox) throw new Error("画布未显示");
    await page.mouse.move(inputBox.x + 100, inputBox.y + 100);
    await page.mouse.down();
    for (let i = 1; i <= 16; i++)
      await page.mouse.move(inputBox.x + 100 + i * 8, inputBox.y + 100 + Math.sin(i));
    const pending = page.locator(".whiteboard .pending");
    const original = await pending.getAttribute("d");
    const endX = inputBox.x + 228;
    const endY = inputBox.y + 100 + Math.sin(16);
    await page.mouse.move(endX + 2.5, endY);
    await page.locator(".whiteboard .pending.corrected").waitFor({ timeout: 5000 });
    const repaired = await pending.getAttribute("d");
    expect(repaired).not.toBe(original);
    // 小抖动仍在原静止区域内，不能因相对推理采样超过 3px 而静默丢掉预览。
    await page.mouse.move(endX - 0.9, endY);
    expect(await page.locator(".whiteboard .pending.corrected").count()).toBe(1);
    expect(await pending.getAttribute("d")).toBe(repaired);
    expect(await page.locator(".whiteboard [data-stroke-id]").count()).toBe(0);
    await page.mouse.up();
    await expect
      .poll(() => page.locator(".whiteboard [data-stroke-id]").getAttribute("d"))
      .toBe(repaired);
    await command(app, "undo");
    await expect.poll(() => page.locator(".whiteboard [data-stroke-id]").count()).toBe(0);
    // 通过浏览器输入协议发送真实 pen 类型事件，验证压力和未抬笔的离开门禁。
    const penBox = await page.getByRole("application", { name: "白板", exact: true }).boundingBox();
    if (!penBox) throw new Error("新白板未显示");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: penBox.x + 100,
      y: penBox.y + 100,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "pen",
      force: 0.2,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: penBox.x + 150,
      y: penBox.y + 140,
      button: "left",
      buttons: 1,
      pointerType: "pen",
      force: 0.8,
    });
    await command(app, "new-note");
    await confirmNewEntry(page);
    await page.locator(".ProseMirror").first().waitFor();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: penBox.x + 150,
      y: penBox.y + 140,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "pen",
    });
    await cdp.detach();
    const penBoard = JSON.parse(await readFile(join(vault, "白板.noemoriboard"), "utf8"));
    expect(penBoard.strokes).toHaveLength(1);
    expect(penBoard.strokes[0].points[0].pressure).toBeCloseTo(0.2);
    expect(penBoard.strokes[0].points.at(-1).pressure).toBeCloseTo(0.8);
  } finally {
    await app.close();
  }
});

test("多笔画停笔：线程联动预览、整组撤销、保存与重启", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-whiteboard-scene-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault"),
    userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const point = (x: number, y: number) => ({ x, y, pressure: 0.5 }),
    edge = (a: ReturnType<typeof point>, b: ReturnType<typeof point>) =>
      Array.from({ length: 49 }, (_, i) =>
        point(
          a.x + ((b.x - a.x) * i) / 48 + Math.sin(i * 1.3),
          a.y + ((b.y - a.y) * i) / 48 + Math.sin(i * 1.7),
        ),
      ),
    original = {
      version: 2,
      strokes: [
        { id: "a", width: 2, points: edge(point(150, 150), point(450, 151)) },
        { id: "b", width: 2, points: edge(point(450, 151), point(449, 330)) },
        { id: "c", width: 2, points: edge(point(449, 330), point(148, 330)) },
      ],
    };
  const path = join(vault, "Scene.noemoriboard");
  await writeFile(path, JSON.stringify(original));
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      reader: {
        vaultRoot: vault,
        currentPath: "Scene.noemoriboard",
        filesCollapsed: true,
        leftWidth: 232,
      },
      appearance: "light",
      window: null,
    }),
  );
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少Electron");
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
  const command = async (id: string) =>
    app.evaluate(({ Menu }, action) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(action);
      if (!item?.enabled) throw new Error(`命令不可用：${action}`);
      item.click();
    }, id);
  const saved = async () => JSON.parse(await readFile(path, "utf8")) as typeof original;
  try {
    let page = await app.firstWindow();
    await page.getByRole("application", { name: "白板", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    await documentTools(page);
    await page.getByRole("toolbar", { name: "白板编辑工具栏", exact: true }).waitFor();
    await expect
      .poll(async () => (await page.locator(".whiteboard").boundingBox())?.width ?? 0)
      .toBeGreaterThan(600);
    const strokes = page.locator(".whiteboard [data-stroke-id]");
    await expect.poll(() => strokes.count()).toBe(3);
    await page.getByRole("button", { name: "查看全部", exact: true }).click();
    await page.locator(".whiteboard").focus();
    await page.waitForFunction(async () => {
      const g = document.querySelector(".whiteboard .board-canvas > g") as SVGGElement | null;
      if (!g) return false;
      const first = g.getScreenCTM();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const last = g.getScreenCTM(),
        local = g.transform.baseVal.consolidate()?.matrix,
        rect = g.ownerSVGElement?.getBoundingClientRect();
      return (
        first &&
        last &&
        local &&
        rect &&
        first.a === last.a &&
        first.e === last.e &&
        first.f === last.f &&
        Math.abs(last.e - rect.left - local.e) < 0.1 &&
        Math.abs(last.f - rect.top - local.f) < 0.1
      );
    });
    const before = await strokes.evaluateAll((items) =>
        items.map((item) => item.getAttribute("d")),
      ),
      matrix = await page.locator(".whiteboard .board-canvas > g").evaluate((element) => {
        const matrix = (element as SVGGElement).getScreenCTM();
        if (!matrix) throw new Error("缺少画布矩阵");
        return { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f };
      });
    await page.mouse.move(matrix.e + 148 * matrix.a, matrix.f + 330 * matrix.d);
    await page.mouse.down();
    for (let i = 1; i <= 48; i++) {
      const x = 148 + (2 * i) / 48 + Math.sin(i * 1.7),
        y = 330 - (180 * i) / 48;
      await page.mouse.move(matrix.e + x * matrix.a, matrix.f + y * matrix.d);
    }
    await page.locator(".whiteboard .pending.corrected").waitFor({ timeout: 7000 });
    expect(await saved()).toEqual(original);
    expect(
      await strokes.evaluateAll((items) => items.map((item) => item.getAttribute("d"))),
    ).not.toEqual(before);
    await page.mouse.up();
    await expect.poll(async () => (await saved()).strokes.length, { timeout: 8000 }).toBe(4);
    const repaired = await saved();
    for (const stroke of repaired.strokes.slice(0, 3)) {
      expect(stroke.points).toHaveLength(2);
      expect(stroke).toHaveProperty("source");
    }
    await command("undo");
    await expect.poll(() => strokes.count()).toBe(3);
    await expect
      .poll(async () => (await saved()).strokes, { timeout: 8000 })
      .toEqual(original.strokes);
    await command("redo");
    await expect.poll(saved, { timeout: 8000 }).toEqual(repaired);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("application", { name: "白板", exact: true }).waitFor();
    await expect.poll(() => page.locator(".whiteboard [data-stroke-id]").count()).toBe(4);
    expect(await saved()).toEqual(repaired);
    expect(await page.locator(".whiteboard .error").allTextContents()).toEqual([]);
  } finally {
    await app.close();
  }
});
