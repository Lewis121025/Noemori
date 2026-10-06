import { noteAction, openLibrary } from "../support/workspace-actions";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("侧栏全文搜索：长词、中文短词、标签谓词与命中定位", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-search-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "notes"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    ...Array.from({ length: 105 }, (_, index) =>
      writeFile(
        join(vault, `notes/page-${index}.md`),
        `# ${index === 104 ? "pageproof" : `分页 ${index}`}\n\npageproof\n`,
      ),
    ),
    writeFile(
      join(vault, "设计笔记.md"),
      [
        "---",
        "status: draft",
        "tags: [project]",
        "---",
        "",
        "# 设计笔记",
        "",
        "这是关于量子检索的正文。",
        "",
        "## 小节",
        "",
        "```ts",
        "const quantumToken = 1;",
        "```",
        "",
        "预算还在讨论",
        "",
        "预算与审批都已完成",
        "",
        "预算**审批**",
        "",
        "预算审批",
        "",
      ].join("\n"),
    ),
    writeFile(join(vault, "其它笔记.md"), "# 其它\n\n无关内容。\n"),
    writeFile(
      join(vault, "密集命中.md"),
      `# 密集\n\n${Array.from({ length: 46 }, (_, i) => `第 ${i + 1} 处 denseneedle\n\n`).join("")}`,
    ),
    writeFile(join(vault, "notes/量子.md"), "# 量子\n\n量子力学笔记 #project\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "其它笔记.md",
          filesCollapsed: false,
          leftWidth: 260,
        },
        appearance: "light",
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
    colorScheme: null,
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
    const files = page.locator(".search-content");
    const search = files.getByRole("searchbox");
    const status = files.locator(".status");
    const hitPaths = async () =>
      files.locator(".hit .path").evaluateAll((nodes) => nodes.map((node) => node.textContent));

    // 等待启动恢复完成：当前文档就绪且切换门禁释放。
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "其它笔记.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );

    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("quantumTken");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect(await files.locator(".semantic-status").textContent()).toContain("安装本地模型");
    expect(await files.locator(".semantic-evidence").first().textContent()).toContain("拼写近似");
    expect(await hitPaths()).toContain("设计笔记.md");

    // 长词走 trigram 索引；结果替换文件树，摘要圈出命中词。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"量子检索"');
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect(await status.textContent()).toContain("共 1 篇");
    expect(await hitPaths()).toEqual(["设计笔记.md"]);
    expect(await files.locator(".hit mark").textContent()).toBe("量子检索");
    expect(await files.getByRole("treeitem").count()).toBe(0);

    // 点击命中：打开文件并把光标定位到命中词所在文本。
    await files.locator(".hit").first().click();
    await page.waitForFunction(() => {
      const selection = document.getSelection();
      const text = selection?.anchorNode?.parentElement?.textContent ?? "";
      return (
        document.querySelector(".document-name")?.textContent === "设计笔记.md" &&
        text.includes("量子检索")
      );
    });

    // 围栏代码里的命中同样可定位（全文索引覆盖代码块）。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"quantumToken"');
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    await files.locator(".hit").first().click();
    await page.waitForFunction(() => {
      const selection = document.getSelection();
      return (selection?.anchorNode?.parentElement?.textContent ?? "").includes("quantumToken");
    });

    // 跨格式的完整词按真实范围选中；第二处不能回到第一处同名文本。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"预算审批"');
    await search.press("Enter");
    await expect.poll(() => status.textContent()).toContain("共 1 篇 · 2 处命中");
    await files.getByRole("button", { name: "展开 设计笔记 的 2 处命中" }).click();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await files.locator(".occurrence").first().click();
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("预算审批");
    expect(
      await page.evaluate(
        () =>
          document.getSelection()?.anchorNode?.parentElement?.closest("p")?.querySelector("strong")
            ?.textContent,
      ),
    ).toBe("审批");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await files.locator(".occurrence").nth(1).click();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          text: document.getSelection()?.toString(),
          strong: Boolean(
            document
              .getSelection()
              ?.anchorNode?.parentElement?.closest("p")
              ?.querySelector("strong"),
          ),
          message: document.querySelector(".message p")?.textContent ?? "",
        })),
      )
      .toEqual({ text: "预算审批", strong: false, message: "" });
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("预算审批");

    // 源码视图使用同一字节范围，保持选中的仍是第二处完整词。
    await noteAction(page, "切换源码视图");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await files.locator(".occurrence").nth(1).click();
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("预算审批");
    await noteAction(page, "切换排版视图");

    // 同一行查询只展示满足完整条件的行，不用文档里更早的同名词制造摘要。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("line:(预算 审批)");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    await files.locator(".hit").first().click();
    await expect
      .poll(() =>
        page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.textContent),
      )
      .toBe("预算与审批都已完成");

    // 中文两字短词走短词索引：结果仍然完整。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"量子"');
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);

    // OR 的短词分支独立召回，不能因为另一个分支使用长词索引而漏掉它。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("quantumToken OR 量子");
    await search.press("Enter");
    await expect.poll(() => status.textContent()).toContain("共 2 篇");
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);

    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("量子检索 OR path:其它");
    await search.press("Enter");
    await expect.poll(() => status.textContent()).toContain("共 2 篇");
    expect((await hitPaths()).sort()).toEqual(["其它笔记.md", "设计笔记.md"]);

    // 标签谓词：frontmatter 与行内标签同表可查。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("tag:project");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);

    // 无结果与退出：第一次 Escape 回到文件树并保留查询词（树仍按其过滤），
    // 第二次 Escape 清空过滤词，恢复完整文件树。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"绝对不存在的词"');
    await search.press("Enter");
    await expect
      .poll(async () => files.locator(".empty").textContent())
      .toContain("没有匹配的笔记");
    await search.press("Escape");
    expect(await search.inputValue()).toBe('"绝对不存在的词"');
    expect(await files.getByRole("treeitem").count()).toBe(0);
    await files.getByRole("button", { name: "清除搜索", exact: true }).click();
    expect(await search.inputValue()).toBe("");

    // 标签面板：组树展示计数（frontmatter 与行内标签同表汇总），点击进入 tag: 检索。
    await openLibrary(page);
    const manager = page.getByRole("region", { name: "文件系统", exact: true });
    await manager.getByRole("button", { name: "浏览标签", exact: true }).click();
    await expect
      .poll(async () => manager.locator(".tag .name").allTextContents())
      .toEqual(["#project"]);
    await expect.poll(async () => manager.locator(".tag .count").allTextContents()).toEqual(["2"]);
    await manager.locator(".tag", { hasText: "project" }).click();
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);
    expect(await search.inputValue()).toBe("tag:project");

    // 单篇首批五处，继续展开才读取下一批；计数不随加载变化，最后一处仍可精确定位。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill('"denseneedle"');
    await search.press("Enter");
    await expect.poll(() => status.textContent()).toContain("共 1 篇 · 46 处命中");
    await files.getByRole("button", { name: "展开 密集 的 46 处命中", exact: true }).click();
    expect(await files.locator(".occurrence").count()).toBe(5);
    for (const count of [25, 45, 46]) {
      await files.getByRole("button", { name: /显示更多 · 还有/ }).click();
      await expect.poll(() => files.locator(".occurrence").count()).toBe(count);
      expect(await status.textContent()).toContain("共 1 篇 · 46 处命中");
    }
    expect(await files.getByRole("button", { name: /显示更多 · 还有/ }).count()).toBe(0);
    const lastOccurrence = await files.locator(".occurrence").last().elementHandle();
    await files.locator(".occurrence").last().focus();
    const trigger = join(vault, "刷新触发.md");
    await writeFile(trigger, "denseneedle\n");
    await expect.poll(() => status.textContent()).toContain("共 2 篇 · 47 处命中");
    expect(await files.locator(".occurrence").count()).toBe(46);
    expect(await lastOccurrence!.evaluate((node) => node === document.activeElement)).toBe(true);
    await rm(trigger);
    await expect.poll(() => status.textContent()).toContain("共 1 篇 · 46 处命中");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await files.locator(".occurrence").last().click();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          file: document.querySelector(".document-name")?.textContent,
          text: document.getSelection()?.toString(),
          message: document.querySelector(".message p")?.textContent ?? "",
          focused: document.activeElement?.classList.contains("ProseMirror"),
        })),
      )
      .toEqual({ file: "密集命中.md", text: "denseneedle", message: "", focused: true });
    await expect
      .poll(() =>
        page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.textContent),
      )
      .toBe("第 46 处 denseneedle");

    // 超过首屏仍能逐页浏览；已加载数量不能冒充全库总数。
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await search.fill("pageproof OR absentprobe");
    await search.press("Enter");
    await expect.poll(() => files.locator(".hit").count()).toBe(100);
    expect((await hitPaths())[0]).toBe("notes/page-104.md");
    expect(await status.textContent()).toContain("已显示 100 篇");
    await files.getByRole("button", { name: "加载更多结果", exact: true }).click();
    await expect.poll(() => status.textContent()).toContain("共 105 篇");
    expect(await files.locator(".hit").count()).toBe(105);
    expect(new Set(await hitPaths()).size).toBe(105);
    expect(await files.getByRole("button", { name: "加载更多结果", exact: true }).count()).toBe(0);

    // 已加载的后续页跨刷新保留；排序变化按路径恢复焦点，删除后落到邻近文件。
    const focusedPath = await files.locator(".hit").last().getAttribute("title");
    if (focusedPath === null) throw new Error("搜索结果缺少路径");
    await files.locator(".hit").last().focus();
    await writeFile(trigger, "# pageproof\n\npageproof\n");
    await expect.poll(() => status.textContent()).toContain("共 106 篇");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("title"))).toBe(
      focusedPath,
    );
    expect(await files.locator('.hit[tabindex="0"]').getAttribute("title")).toBe(focusedPath);
    const beforeRemoval = await hitPaths();
    const focusedIndex = beforeRemoval.indexOf(focusedPath);
    const neighbor = beforeRemoval[focusedIndex + 1] ?? beforeRemoval[focusedIndex - 1];
    await rm(join(vault, focusedPath));
    await expect.poll(() => status.textContent()).toContain("共 105 篇");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("title")))
      .toBe(neighbor);

    // 外部新增、修改与删除都自动更新当前查询，保留仍存在的命中节点和焦点。
    await search.fill('"autorefreshproof"');
    await search.press("Enter");
    await expect.poll(() => status.textContent()).toContain("共 0 篇");
    const external = join(vault, "自动刷新.md");
    await writeFile(external, "autorefreshproof\n");
    await expect.poll(() => status.textContent()).toContain("共 1 篇 · 1 处命中");
    const retained = await files.locator(".hit").first().elementHandle();
    await files.locator(".hit").first().focus();
    await writeFile(external, "autorefreshproof\n\nautorefreshproof\n");
    await expect.poll(() => status.textContent()).toContain("共 1 篇 · 2 处命中");
    expect(
      await retained!.evaluate((node) => node.isConnected && node === document.activeElement),
    ).toBe(true);
    expect(await search.inputValue()).toBe('"autorefreshproof"');
    await rm(external);
    await expect.poll(() => status.textContent()).toContain("共 0 篇");
    await expect.poll(() => search.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
