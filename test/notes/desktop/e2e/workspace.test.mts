import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("工作区操作、外观持久化与复杂公式和 HTML 离线渲染", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-workspace-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "我的笔记");
  const userData = join(root, "state");
  const richNote = String.raw`# 数学与 HTML

行内公式：$E=mc^2$。

$$
\begin{aligned}
\nabla\cdot\mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla\times\mathbf{B} &= \mu_0\mathbf{J}+\mu_0\varepsilon_0\frac{\partial\mathbf{E}}{\partial t}
\end{aligned}
$$

$$
A=\begin{bmatrix}1 & 2 & 3 \\ 4 & 5 & 6 \\ 7 & 8 & 9\end{bmatrix},\qquad
f(x)=\begin{cases}x^2 & x\ge 0 \\ -x & x<0\end{cases}
$$

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx=\sqrt{\pi},\qquad
\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}
$$

<div style="padding:16px;border:1px solid currentColor;border-radius:8px">
<strong>HTML 内容预览</strong>
<table><thead><tr><th>项目</th><th>状态</th></tr></thead><tbody><tr><td>嵌套表格</td><td>已渲染</td></tr></tbody></table>
<svg width="100" height="30" viewBox="0 0 100 30"><circle cx="15" cy="15" r="12" fill="currentColor" /></svg>
<script>window.unwantedHtmlScript = true;</script>
</div>
`;
  await Promise.all([mkdir(vault), mkdir(userData)]);
  await Promise.all([
    writeFile(join(vault, "渲染验证.md"), richNote),
    writeFile(
      join(vault, "设计随想.md"),
      "# 让写作回归简单\n\n把注意力留给文字，让工具安静地陪伴。\n\n## 少一点选择\n\n每天打开笔记，就能继续昨天的思考。\n\n## 恰好需要的时候\n\n目录与引用，在需要时自然出现。\n",
    ),
    writeFile(
      join(vault, "阅读记录.md"),
      "# 阅读记录\n\n今天重读了 [[设计随想]]，决定从减少界面干扰开始。\n",
    ),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        vaultRoot: vault,
        currentPath: "设计随想.md",
        filesCollapsed: false,
        leftWidth: 232,
        rightSlots: [
          { viewId: "backlinks", pinnedPath: "阅读记录.md" },
          { viewId: "outline", pinnedPath: null },
        ],
        rightSplit: true,
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
  const launch = () =>
    electron.launch({
      executablePath: executable,
      // Playwright 默认强制浅色；此处交由 Electron 的真实应用偏好决定。
      colorScheme: null,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      env: environment,
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".ProseMirror").waitFor();
    await page.locator(".references summary").waitFor();
    expect(await page.locator(".file-sidebar").count()).toBe(1);
    // PDF 预览的全局样式不能给文件栏添加浮层圆角、内边距或阴影。
    expect(
      await page.locator(".file-sidebar").evaluate((aside) => {
        const style = getComputedStyle(aside);
        return { radius: style.borderRadius, padding: style.paddingTop, shadow: style.boxShadow };
      }),
    ).toEqual({ radius: "0px", padding: "0px", shadow: "none" });
    expect(await page.locator("#outline-panel").isVisible()).toBe(false);
    expect(await page.locator(".entry-dialog").isVisible()).toBe(false);
    expect(await page.locator(".references details").getAttribute("open")).toBeNull();
    expect(await page.locator(".references summary").innerText()).toBe("被 1 篇笔记引用");

    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page.getByRole("navigation", { name: "文档目录" }).waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator("#outline-panel").isVisible()).toBe(false);
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page.getByRole("button", { name: "少一点选择", exact: true }).click();
    expect(await page.locator("#outline-panel").isVisible()).toBe(false);

    await page.locator(".references summary").click();
    await page.locator(".references .hit").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "阅读记录.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    expect(await page.locator(".ProseMirror").innerText()).toContain("今天重读了");
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "设计随想.md", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "设计随想.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    expect(await page.locator(".references details").getAttribute("open")).toBeNull();

    const beginRename = async () => {
      await page.getByRole("button", { name: "笔记操作", exact: true }).click();
      await page.getByRole("button", { name: "重命名…", exact: true }).click();
      await page.getByRole("dialog", { name: "重命名" }).waitFor();
    };
    await beginRename();
    expect(
      await page.getByLabel("文件名", { exact: true }).evaluate((input) =>
        input instanceof HTMLInputElement
          ? {
              focused: document.activeElement === input,
              selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
            }
          : null,
      ),
    ).toEqual({ focused: true, selected: "设计随想" });
    await page.keyboard.press("Escape");
    expect(await page.locator(".entry-dialog").isVisible()).toBe(false);
    expect(await readFile(join(vault, "设计随想.md"), "utf8")).toContain("让写作回归简单");
    await beginRename();
    await page.getByLabel("文件名", { exact: true }).fill("安静写作.md");
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "安静写作.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    expect(await readFile(join(vault, "阅读记录.md"), "utf8")).toContain("[[安静写作]]");
    await expect.poll(() => page.locator(".entry-dialog").isVisible()).toBe(false);

    const paragraph = page.locator(".ProseMirror > p").last();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" 专注当下。");
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
    await expect.poll(() => readFile(join(vault, "安静写作.md"), "utf8")).toContain("专注当下。");

    // 真实 Chromium 验证窄窗口布局与系统深浅色，避免仅靠 jsdom 推断 CSS。
    await page.setViewportSize({ width: 600, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    expect(await page.getByRole("complementary", { name: "文件栏" }).isVisible()).toBe(false);
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page.getByRole("navigation", { name: "文档目录" }).waitFor();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.getByRole("button", { name: "显示或隐藏文件栏" }).click();
    const chooseAppearance = async (name: string) => {
      if (!(await page.locator("#library-menu").isVisible())) {
        await page.getByRole("button", { name: "切换笔记库" }).click();
      }
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(
        (label) =>
          [...document.querySelectorAll('.appearance-options button[aria-pressed="true"]')].some(
            (button) => button.textContent?.includes(label),
          ),
        name,
      );
    };
    await chooseAppearance("浅色");
    await page.waitForFunction(() => !matchMedia("(prefers-color-scheme: dark)").matches);
    const light = await page
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);
    const screenshots = process.env.NOEMORI_WORKSPACE_SCREENSHOTS;
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "noemori-appearance-light.png") });
    await chooseAppearance("深色");
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    const dark = await page
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);
    expect(dark).not.toBe(light);
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    expect(JSON.parse(await readFile(join(userData, "session.json"), "utf8")).appearance).toBe(
      "dark",
    );
    // IPC 只接受外观枚举，不能借主题输入改写其他会话字段。
    const invalid = await page.evaluate(async () => {
      try {
        await Reflect.apply(window.noemori.app.appearanceSet, null, [
          { appearance: "light", vaultRoot: "/unexpected" },
        ]);
        return "accepted";
      } catch {
        return "rejected";
      }
    });
    expect(invalid).toBe("rejected");
    expect(await page.evaluate(() => window.noemori.app.appearanceGet())).toBe("dark");
    await chooseAppearance("跟随系统");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
    await page.emulateMedia({ colorScheme: "light" });
    expect(
      await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
    ).toBe(light);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(
      await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
    ).toBe(dark);
    await page.emulateMedia({ colorScheme: null });
    await chooseAppearance("深色");
    if (screenshots) await page.screenshot({ path: join(screenshots, "noemori-appearance-dark.png") });
    await page.keyboard.press("Escape");

    const remoteRequests: string[] = [];
    await page.route(/^https?:/, (route) => {
      remoteRequests.push(route.request().url());
      return route.abort();
    });
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "渲染验证.md", exact: true })
      .click();
    await page.waitForFunction(() => document.querySelectorAll("mjx-container").length === 4);
    expect(await page.locator("mjx-merror, .math-error").count()).toBe(0);
    expect(await page.locator("mjx-mtable").count()).toBeGreaterThanOrEqual(3);
    // 矩阵括号必须纵向伸展；仅有 MathJax 节点不能证明自适应样式仍有效。
    const delimiters = await page.locator("mjx-stretchy-v").evaluateAll((elements) =>
      elements.map((element) => ({
        display: getComputedStyle(element).display,
        height:
          element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).fontSize),
      })),
    );
    expect(delimiters).toHaveLength(2);
    for (const delimiter of delimiters) {
      expect(delimiter.display).toBe("inline-block");
      expect(delimiter.height).toBeGreaterThan(3);
    }
    expect(await page.locator(".html-block table").innerText()).toContain("已渲染");
    expect(await page.locator(".html-block svg circle").count()).toBe(1);
    expect(await page.locator(".html-block script").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "unwantedHtmlScript"))).toBeUndefined();
    await page.evaluate(() => document.fonts.ready);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "noemori-rich-content-dark.png") });
    expect(remoteRequests).toEqual([]);
    expect(await readFile(join(vault, "渲染验证.md"), "utf8")).toBe(richNote);
    // 返回同一篇笔记会命中公式缓存，样式仍须保留，不能依赖重新排版补回。
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "阅读记录.md", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("mjx-container").length === 0 &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    await page
      .getByRole("navigation", { name: "文件列表" })
      .getByRole("treeitem", { name: "渲染验证.md", exact: true })
      .click();
    await page.waitForFunction(() => document.querySelectorAll("mjx-container").length === 4);
    expect(
      await page
        .locator("mjx-stretchy-v")
        .first()
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("inline-block");
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator(".ProseMirror").waitFor();
    expect(await reopened.evaluate(() => window.noemori.app.appearanceGet())).toBe("dark");
    expect(await reopened.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
      true,
    );
    await reopened.getByRole("button", { name: "切换笔记库" }).click();
    expect(
      await reopened
        .getByRole("button", { name: "深色", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  } finally {
    await app.close();
  }
});
