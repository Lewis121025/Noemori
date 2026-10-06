import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _electron as electron, type Locator } from "playwright-core";
import { parseMarkdown } from "../../../../modules/notes/packages/desktop/src/features/reader/shared/markdown/parse";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

// 按实际字形所在行判断孤词，避免只检查 CSS 声明而遗漏浏览器未执行优化的情况。
async function lastLineWords(paragraph: Locator): Promise<string[]> {
  return paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error("测试段落应当只有普通文字");
    const words = [...new Intl.Segmenter("en", { granularity: "word" }).segment(text.data)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => {
        const range = document.createRange();
        range.setStart(text, segment.index);
        range.setEnd(text, segment.index + segment.segment.length);
        return { word: segment.segment, top: range.getBoundingClientRect().top };
      });
    const last = Math.max(...words.map((word) => word.top));
    return words.filter((word) => Math.abs(word.top - last) < 1).map((word) => word.word);
  });
}

test("阅读节奏：尾行不落单，连续标题紧邻，空格与代码在编辑撤销后保真", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-typography-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault), mkdir(userData)]);
  const paragraph =
    "This is a short paragraph that needs better line breaking to keep the last word together.";
  const code = "    code with  two spaces\n    keep indentation";
  const source =
    `# 阅读节奏\n\n${paragraph}\n\n## 第一节\n\n### 深层小节\n\n` +
    "第一段保留  双空格。\n\n第二段继续阅读。\n\n## 下一章\n\n" +
    `\`\`\`text\n${code}\n\`\`\`\n`;
  const file = join(vault, "阅读.md");
  await Promise.all([
    writeFile(file, source),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        appearance: "light",
        readingFont: "lora",
        reader: { vaultRoot: vault, currentPath: "阅读.md", filesCollapsed: true },
      }),
    ),
  ]);
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("缺少 Electron 可执行文件");
  const app = await electron.launch({
    executablePath,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    // 固定窄阅读列重现旧版末行只剩 together 的情况，字体使用应用的离线资源。
    const width = await page.addStyleTag({
      content: ".document-body { max-width: 388px !important; }",
    });
    const english = editor.locator(":scope > p").first();
    expect.soft((await lastLineWords(english)).length).toBeGreaterThan(1);
    const gaps = await editor.evaluate((element) => {
      const chapter = element.querySelector("h2");
      const subsection = element.querySelector("h3");
      const next = element.querySelectorAll("h2")[1];
      const previous = next?.previousElementSibling;
      if (!chapter || !subsection || !next || !previous) throw new Error("缺少测试标题");
      return {
        nested: subsection.getBoundingClientRect().top - chapter.getBoundingClientRect().bottom,
        section: next.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
      };
    });
    expect.soft(gaps.nested).toBeLessThan(12);
    expect.soft(gaps.section).toBeGreaterThan(gaps.nested * 2);
    await width.evaluate((element) => element.parentNode?.removeChild(element));

    expect(await editor.locator("pre code").textContent()).toBe(code);
    expect(await readFile(file, "utf8")).toBe(source);
    await english.evaluate((element) => {
      const text = element.firstChild;
      const host = element.closest<HTMLElement>(".ProseMirror");
      if (!(text instanceof Text) || !host) throw new Error("缺少可编辑段落");
      host.focus({ preventScroll: true });
      document.getSelection()?.setBaseAndExtent(text, text.length, text, text.length);
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const addition = "  保留  空格";
    await page.keyboard.insertText(addition);
    await page.keyboard.press("ControlOrMeta+s");
    // Markdown 允许用字符实体保留空格；编辑后的文字按语义核对，未改的代码按字节核对。
    await expect
      .poll(async () => parseMarkdown(await readFile(file, "utf8")).child(1).textContent)
      .toBe(paragraph + addition);
    expect(await readFile(file, "utf8")).toContain(`\`\`\`text\n${code}\n\`\`\``);
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => readFile(file, "utf8")).toBe(source);
    expect(await editor.locator("pre code").textContent()).toBe(code);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
