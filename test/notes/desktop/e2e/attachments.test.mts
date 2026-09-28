import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("生产窗口离线预览图片与 PDF，嵌入交互不修改文档或附件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-attachment-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const pdf = await readFile(new URL("../fixtures/preview.pdf", import.meta.url));
  const svg = await readFile(new URL("../fixtures/preview.svg", import.meta.url));
  const markdown = "# Attachments\n\n[论文](preview.pdf)\n\n![[preview.svg]]\n\n![[preview.pdf]]\n";
  await Promise.all([
    writeFile(join(vault, "preview.pdf"), pdf),
    writeFile(join(vault, "preview.svg"), svg),
    writeFile(join(vault, "note.md"), markdown),
    writeFile(join(vault, "broken.pdf"), "invalid PDF"),
    writeFile(join(vault, "binary.zip"), new Uint8Array([80, 75, 3, 4, 0, 255])),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        vaultRoot: vault,
        currentPath: "preview.pdf",
        filesCollapsed: false,
        outlineCollapsed: false,
        window: null,
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  }
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const remoteRequests: string[] = [];
    await page.route(/^https?:/, (route) => {
      remoteRequests.push(route.request().url());
      return route.abort();
    });
    const files = page.getByRole("navigation", { name: "文件列表" });
    const open = async (name: string) => {
      await files.getByRole("treeitem", { name, exact: true }).click();
      await page.waitForFunction(
        (path) =>
          document.querySelector(".quick-navigation .file.active")?.getAttribute("aria-label") ===
            path && !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
      await expect
        .poll(() =>
          page
            .locator("section[data-pane]")
            .evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
    };
    const ready = (number: number) =>
      page.waitForFunction(
        (value) =>
          document
            .querySelector(".preview-stage:not(.concealed) .textLayer")
            ?.textContent?.includes(`page ${value}`),
        number,
      );

    await ready(1);
    const mentions = await page.evaluate(() => window.nous.reader.indexMentionsTo("preview.pdf"));
    expect(mentions.linked.some((mention) => mention.fromPath === "note.md")).toBe(true);
    const session = await page.evaluate(async () => {
      const panes = await window.nous.reader.sessionGetPanes();
      // 经 IPC 提交布局时，额外字段不能改写当前库或文件。
      const submitted = {
        ...panes,
        leftWidth: 240,
        vaultRoot: "/unexpected",
        currentPath: "unexpected.md",
      };
      await window.nous.reader.sessionSetPanes(submitted);
      return window.nous.reader.sessionGetPanes();
    });
    expect(session.leftWidth).toBe(240);
    expect(session).not.toHaveProperty("vaultRoot");
    expect(JSON.parse(await readFile(join(userData, "session.json"), "utf8")).reader).toMatchObject(
      {
        vaultRoot: vault,
        documents: { panes: [{ currentPath: "preview.pdf" }], active: 0 },
        leftWidth: 240,
      },
    );
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    expect(await page.getByRole("button", { name: "保存", exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await ready(2);
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await ready(2);
    expect(
      await page.locator(".pdf-page canvas").evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) return false;
        const context = canvas.getContext("2d");
        if (!context) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 1]! > pixels[i]! + 40) return true;
        }
        return false;
      }),
    ).toBe(true);
    expect(
      await page
        .locator(".textLayer span")
        .first()
        .evaluate((span) => span.getBoundingClientRect().height),
    ).toBeGreaterThan(10);
    expect(
      await page.locator(".textLayer").evaluate((layer) => {
        const selection = window.getSelection();
        selection?.selectAllChildren(layer);
        return selection?.toString();
      }),
    ).toContain("page 2");

    await open("preview.svg");
    await page.waitForFunction(() => {
      const image = document.querySelector(".attachment-preview img");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1200;
    });
    await page.getByRole("button", { name: "原始大小", exact: true }).click();
    expect(
      await page
        .locator(".attachment-preview img")
        .evaluate((image) => image.getBoundingClientRect().width),
    ).toBe(1200);
    const imageViewport = page.getByRole("region", { name: "图片画布" });
    const bounds = await imageViewport.boundingBox();
    if (bounds === null) throw new Error("图片预览区域不可见");
    await page.mouse.move(bounds.x + 200, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 80, bounds.y + 100);
    await page.mouse.up();
    expect(await imageViewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    await page.getByRole("button", { name: "适应窗口", exact: true }).click();
    expect(
      await page
        .locator(".attachment-preview img")
        .evaluate((image) => image.getBoundingClientRect().width),
    ).toBeLessThan(1200);

    await open("note.md");
    const embeddedImage = page.locator(".note-image");
    await embeddedImage.click();
    expect(await page.locator(".quick-navigation .file.active").getAttribute("aria-label")).toBe(
      "note.md",
    );
    await embeddedImage.click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("region", { name: "图片画布" }).waitFor();
    expect(await page.locator(".quick-navigation .file.active").getAttribute("aria-label")).toBe(
      "preview.svg",
    );
    await open("note.md");
    // 图片打开即加载后，PDF 可能在屏外；先滚到嵌入段落，再等待按需预览。
    await page.locator(".ProseMirror > p").last().scrollIntoViewIfNeeded();
    await ready(1);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await ready(2);
    expect(await page.locator(".save-status").innerText()).toBe("已保存");
    await page.getByRole("button", { name: "打开附件", exact: true }).click();
    await ready(1);
    expect(await page.locator(".quick-navigation .file.active").getAttribute("aria-label")).toBe(
      "preview.pdf",
    );

    await open("note.md");
    await page
      .getByRole("link", { name: "论文", exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
    await ready(1);
    await open("broken.pdf");
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain("PDF 无法读取");
    await open("binary.zip");
    await page.getByRole("heading", { name: "暂不支持预览此文件" }).waitFor();
    await page.getByRole("button", { name: "笔记操作", exact: true }).click();
    expect(await page.getByRole("button", { name: "保存", exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  } finally {
    await app.close();
  }
  expect(await readFile(join(vault, "preview.pdf"))).toEqual(pdf);
  expect(await readFile(join(vault, "preview.svg"))).toEqual(svg);
  expect(await readFile(join(vault, "note.md"), "utf8")).toBe(markdown);
});
