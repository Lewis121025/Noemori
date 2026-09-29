import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("无工具栏白板：正文插入、手势编辑、保存重启、改名和嵌入关系", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-whiteboard-"));
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
      .getByRole("button", { name: "打开白板 attachments/白板.nousboard", exact: true })
      .waitFor();
    await expect
      .poll(() => readFile(join(vault, "Home.md"), "utf8"), { timeout: 8000 })
      .toContain("![[attachments/白板.nousboard]]");
    await page
      .getByRole("button", { name: "打开白板 attachments/白板.nousboard", exact: true })
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
      if (hold) await page.locator(".whiteboard .selection").waitFor();
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
    expect(await page.locator(".whiteboard path.selected").count()).toBe(2);
    expect(await strokes.count()).toBe(3);
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
    const boardPath = join(vault, "attachments", "白板.nousboard");
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
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    await page.getByRole("button", { name: "重命名…", exact: true }).click();
    await page.locator("#entry-name").fill("整理.nousboard");
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await expect
      .poll(() => readFile(join(vault, "Home.md"), "utf8"), { timeout: 8000 })
      .toContain("整理.nousboard");
    await command(app, "go-back");
    await page
      .getByRole("button", { name: "打开白板 attachments/整理.nousboard", exact: true })
      .waitFor();
    expect(await page.locator(".whiteboard-preview path").count()).toBe(3);
    expect(await readFile(join(vault, "Home.md"), "utf8")).toContain("保留后文");
    await page.getByRole("button", { name: "新建白板", exact: true }).click();
    await page.getByRole("application", { name: "白板", exact: true }).waitFor();
    expect(await page.locator(".whiteboard button").count()).toBe(0);
    expect(await page.locator(".whiteboard [data-stroke-id]").count()).toBe(0);
    // 停笔保留自由笔迹，抬笔提交相同轮廓且可整体撤销。
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
    await page.waitForTimeout(550);
    expect(await pending.getAttribute("d")).toBe(original);
    expect(await page.locator(".whiteboard [data-stroke-id]").count()).toBe(0);
    await page.mouse.up();
    await expect
      .poll(() => page.locator(".whiteboard [data-stroke-id]").getAttribute("d"))
      .toBe(original);
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
    const penBoard = JSON.parse(await readFile(join(vault, "白板.nousboard"), "utf8"));
    expect(penBoard.strokes).toHaveLength(1);
    expect(penBoard.strokes[0].points[0].pressure).toBeCloseTo(0.2);
    expect(penBoard.strokes[0].points.at(-1).pressure).toBeCloseTo(0.8);
  } finally {
    await app.close();
  }
});
