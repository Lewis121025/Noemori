import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { unzipSync } from "fflate";
import type { ExportRequest } from "../../../../modules/notes/packages/desktop/src/features/reader/shared/export";
import { launchExportApp } from "../support/export-app";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("EXP-MERMAID 独立 SVG 保留图中文字，源内配置不能重新启用会丢字的 HTML 标签", async (t) => {
  const cases = [
    {
      name: "flow",
      source: "flowchart LR\n A[开始] -->|检查| B[完成]",
      labels: ["开始", "检查", "完成"],
    },
    {
      name: "configured",
      source:
        "---\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\nflowchart LR\n A[配置覆盖] --> B[完整保留]",
      labels: ["配置覆盖", "完整保留"],
    },
    {
      name: "sequence",
      source:
        "sequenceDiagram\n participant A as 用户\n participant B as 导出器\n A->>B: 保存笔记\n B-->>A: 返回结果",
      labels: ["用户", "导出器", "保存笔记", "返回结果"],
    },
    {
      name: "state",
      source:
        'stateDiagram-v2\n state "等待保存" as Saving\n state "完成导出" as Done\n Saving --> Done: 校验通过',
      labels: ["等待保存", "完成导出", "校验通过"],
    },
  ];
  const fixture = await launchExportApp(
    t,
    Object.fromEntries(
      cases.map(({ name, source }) => [`${name}.md`, `\`\`\`mermaid\n${source}\n\`\`\`\n`]),
    ),
  );
  const target = await fixture.destination("diagrams.zip");
  const result = await fixture.page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    fixture.request(
      "markdown",
      cases.map(({ name }) => `${name}.md`),
    ),
  );
  expect(result).toMatchObject({ status: "saved", warning: null, issues: [] });
  const files = unzipSync(await readFile(target));
  const images = Object.entries(files)
    .filter(([path]) => path.endsWith(".svg"))
    .map(([, bytes]) => new TextDecoder().decode(bytes));
  expect(images).toHaveLength(cases.length);
  for (const item of cases) {
    const image = images.find((svg) => item.labels.every((label) => svg.includes(label)));
    expect(image, item.name).toBeDefined();
    expect(image).toContain("<text");
    expect(image).not.toContain("<foreignObject");
  }
});

test("EXP-PDF-LINK 批量 PDF 的跨文件锚点和附件链接可脱离应用目录使用", async (t) => {
  const fixture = await launchExportApp(t, {
    "a.md":
      "# 来源\n\n[跳到目标](b.md#目标)\n\n[附件](asset.bin)\n\n[回到首页](a.md) [本节](#来源)\n",
    "b.md": "# 目标\n\n离线目标正文。\n",
    "asset.bin": "original attachment",
  });
  const target = await fixture.destination("linked.zip");
  const result = await fixture.page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    fixture.request("pdf", ["a.md", "b.md"]),
  );
  expect(result).toMatchObject({ status: "saved", warning: null, issues: [] });
  const files = unzipSync(await readFile(target));
  const a = join(fixture.directory, "a.pdf");
  const b = join(fixture.directory, "b.pdf");
  const source = files["documents/a.pdf"],
    destination = files["documents/b.pdf"];
  if (!source || !destination) throw new Error("缺少批量 PDF");
  await writeFile(a, source);
  await writeFile(b, destination);
  const { stdout: links } = await promisify(execFile)("/opt/homebrew/bin/pdfinfo", ["-url", a]);
  expect(links).not.toContain("file://");
  expect(links).not.toContain("/out/");
  expect(links).toContain("b.pdf#nameddest=");
  expect(links).toMatch(/\.\.\/resources\/[a-f0-9]+\.bin/);
  const anchor = /#nameddest=([a-zA-Z0-9_]+)/.exec(links)?.[1];
  expect(anchor).toBeDefined();
  const { stdout: destinations } = await promisify(execFile)("/opt/homebrew/bin/pdfinfo", [
    "-dests",
    b,
  ]);
  expect(destinations).toContain(`"${anchor}"`);
  expect(destinations).not.toContain("noemori_probe_");
});

test("EXP-RECOVERY 交付确认丢失时保留结果，恢复报告只确认而不重放导出", async (t) => {
  const fixture = await launchExportApp(t, { "a.md": "# 已生成内容\n\n必须保持原样。\n" });
  const target = await fixture.destination("recover.md");
  await fixture.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("reader.export.acknowledge");
    ipcMain.handle("reader.export.acknowledge", () => {
      throw new Error("controlled lost acknowledgement");
    });
  });
  const result = await fixture.page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    fixture.request("markdown", ["a.md"]),
  );
  expect(result).toMatchObject({ status: "saved", warning: expect.stringContaining("交付确认") });
  const original = await readFile(target);
  const notified = fixture.app.evaluate(
    ({ dialog }) =>
      new Promise<string>((resolve) => {
        dialog.showMessageBox = async (first: unknown, second?: unknown) => {
          const options = second ?? first;
          if (
            typeof options !== "object" ||
            options === null ||
            !("detail" in options) ||
            typeof options.detail !== "string"
          )
            throw new Error("恢复对话框没有明确结果");
          resolve(options.detail);
          return { response: 0, checkboxChecked: false };
        };
      }),
  );
  const recovered = fixture.page.evaluate(() => window.noemori.reader.exportRecover());
  const [detail] = await Promise.all([notified, recovered]);
  expect(detail).toContain("已生成：");
  expect(detail).toContain("recover.md");
  expect(await readFile(target)).toEqual(original);
  await fixture.page.evaluate(() => window.noemori.reader.exportRecover());
  expect(fixture.errors).toEqual([]);
});

test("导出完整旅程：保存最新编辑、PDF、原生公式 DOCX、离线 Markdown、原格式及白板", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-export-e2e-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const vault = join(directory, "vault");
  const data = join(directory, "state");
  const output = join(directory, "output");
  await Promise.all([mkdir(vault), mkdir(data), mkdir(output)]);
  const source = [
    "# 导出验收",
    "",
    "中文内容 😀 **结构保留**。",
    "",
    "行内 <strong>HTML加粗</strong> 与 <em>HTML斜体</em>。",
    "",
    "```mermaid",
    "graph LR",
    "  A[开始] --> B[完成]",
    "```",
    "",
    "$\\newcommand{\\half}[1]{\\frac{#1}{2}}\\half{x}$",
    "",
    "$\\half{y}$",
    "",
    "$x_i^2+\\frac{a}{b}$",
    "",
    "| 名称 | 数值 |",
    "| --- | --- |",
    "| 数据 | 42 |",
    "",
    "![[image.svg]]",
    "",
    "![[嵌入]]",
    "",
    "[[不存在]]",
    "",
    "[$z$](不存在.md)",
    "",
  ].join("\n");
  await writeFile(join(vault, "验收.md"), source);
  await writeFile(join(vault, "空白.md"), "");
  await copyFile(
    fileURLToPath(new URL("../fixtures/preview.pdf", import.meta.url)),
    join(vault, "preview.pdf"),
  );
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(38, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(2, 40);
  await writeFile(join(vault, "audio.wav"), wav);
  await writeFile(join(vault, "payload.bin"), "重复附件的原始内容");
  await writeFile(
    join(vault, "丰富内容.md"),
    "# 附件验收\n\n![[preview.pdf#page=1]]\n\n![[audio.wav]]\n\n[附件一](payload.bin) [附件二](payload.bin)\n",
  );
  await writeFile(
    join(vault, "嵌入.md"),
    "## 嵌入正文\n\n嵌入内容标记。\n\n[嵌入内跳转](#嵌入正文)\n",
  );
  await writeFile(
    join(vault, "image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#174d83"/></svg>',
  );
  await writeFile(
    join(vault, "白板.noemoriboard"),
    JSON.stringify({
      version: 1,
      strokes: [
        {
          id: "one",
          width: 4,
          points: [
            { x: -20, y: 0, pressure: 1 },
            { x: 120, y: 80, pressure: 1 },
          ],
        },
      ],
    }),
  );
  await writeFile(
    join(data, "session.json"),
    JSON.stringify({
      reader: { vaultRoot: vault, currentPath: "验收.md", filesCollapsed: true },
      appearance: "dark",
      window: null,
    }),
  );
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${data}`,
      "--no-sandbox",
    ],
    env,
  });
  t.onTestFinished(() => app.close());
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".document-name").filter({ hasText: "验收.md" }).waitFor();
  await page.locator(".ProseMirror").first().getByText("中文内容", { exact: false }).click();
  await page.keyboard.press("End");
  await page.keyboard.type("LATEST-EXPORT");

  async function exportFile(
    format: string,
    filename: string,
    command = "export-document",
  ): Promise<Uint8Array> {
    const target = join(output, filename);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, target);
    await runCommand(app, command);
    const modal = page.getByRole("dialog", { name: /导出/ });
    await modal.waitFor();
    await modal.getByLabel("导出格式").selectOption(format);
    await modal.getByRole("button", { name: "开始导出", exact: true }).click();
    await expect
      .poll(
        async () => {
          const text = await modal.textContent();
          return text?.includes("导出未完成") || text?.includes("导出完成");
        },
        { timeout: 90000 },
      )
      .toBe(true);
    expect(await modal.textContent()).toContain("导出完成");
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    const report = process.env["NOEMORI_EXPORT_REPORT"];
    if (report) {
      await mkdir(report, { recursive: true });
      await copyFile(target, join(report, filename));
    }
    return readFile(target);
  }

  const pdf = await exportFile("pdf", "验收.pdf");
  expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
  expect(await readFile(join(vault, "验收.md"), "utf8")).toContain("LATEST-EXPORT");
  const docx = await exportFile("docx", "验收.docx");
  const docxFiles = unzipSync(docx);
  const xml = new TextDecoder().decode(docxFiles["word/document.xml"]);
  expect(xml).toContain("LATEST-EXPORT");
  expect(xml).toContain("嵌入内容标记");
  expect(xml).toContain("<m:f>");
  expect(xml).toContain("<m:t>z</m:t>");
  expect(xml).toContain("<w:tbl>");
  expect(xml).toContain('<wp:extent cx="1524000" cy="762000"');
  expect(xml).toMatch(/<w:rPr>[^]*?<w:b\s*\/>[^]*?<w:t[^>]*>HTML加粗<\/w:t>/);
  const markdown = unzipSync(await exportFile("markdown", "通用.zip"));
  const note = new TextDecoder().decode(markdown["documents/验收.md"]);
  expect(note).toContain("嵌入内容标记");
  expect(note).not.toContain("![[");
  expect(note).toContain("**HTML加粗**");
  expect(note).toContain("*HTML斜体*");
  expect(note).toMatch(/\[嵌入内跳转\]\(#n[a-f0-9]+_\d+\)/);
  expect(
    Object.keys(markdown).some((path) => path.startsWith("resources/") && path.endsWith(".svg")),
  ).toBe(true);
  const diagram = Object.entries(markdown)
    .filter(([path]) => path.endsWith(".svg"))
    .map(([, bytes]) => new TextDecoder().decode(bytes))
    .find((svg) => svg.includes("export-diagram"));
  expect(diagram).toBeDefined();
  expect(diagram).toContain("开始");
  expect(diagram).toContain("完成");
  await page.evaluate(() =>
    window.noemori.reader.bookmarksSet([{ kind: "file", path: "验收.md", title: "恢复验收书签" }]),
  );
  const archive = unzipSync(await exportFile("archive", "原格式.zip", "export-vault"));
  expect(archive["vault/验收.md"]).toEqual(new Uint8Array(await readFile(join(vault, "验收.md"))));
  expect(archive["vault/白板.noemoriboard"]).toBeDefined();
  expect(archive["vault/空白.md"]?.byteLength).toBe(0);
  expect(archive["export/manifest.json"]).toBeDefined();

  await runCommand(app, "quick-switcher");
  await page.getByPlaceholder("输入文件名、标题或别名…").fill("白板");
  await page.keyboard.press("Enter");
  await page.getByRole("application", { name: "白板", exact: true }).waitFor();
  // 画布挂载早于导航保存门禁释放；原生命令必须等待交互入口真正可用。
  await expect
    .poll(() => page.getByRole("button", { name: "笔记操作", exact: true }).isEnabled())
    .toBe(true);
  const svg = await exportFile("svg", "白板.svg");
  expect(new TextDecoder().decode(svg)).toContain('viewBox="-46 -26 192 132"');
  const png = await exportFile("png", "白板.png");
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  await runCommand(app, "quick-switcher");
  await page.getByPlaceholder("输入文件名、标题或别名…").fill("丰富内容");
  await page.keyboard.press("Enter");
  await page.locator(".document-name").filter({ hasText: "丰富内容.md" }).waitFor();
  await expect
    .poll(() => page.getByRole("button", { name: "笔记操作", exact: true }).isEnabled())
    .toBe(true);
  for (const format of ["pdf", "docx", "markdown"]) {
    const bundle = unzipSync(await exportFile(format, `附件-${format}.zip`));
    const paths = Object.keys(bundle);
    const audio = paths.find((path) => path.endsWith(".wav"));
    const originalPdf = paths.find(
      (path) => path.startsWith("resources/") && path.endsWith(".pdf"),
    );
    expect(audio).toBeDefined();
    expect(originalPdf).toBeDefined();
    expect(bundle[audio!]).toEqual(new Uint8Array(wav));
    expect(bundle[originalPdf!]).toEqual(
      new Uint8Array(await readFile(join(vault, "preview.pdf"))),
    );
    expect(paths).toContain(`documents/丰富内容.${format === "markdown" ? "md" : format}`);
    expect(
      paths.filter((path) => path.startsWith("resources/") && path.endsWith(".bin")),
    ).toHaveLength(1);
  }

  const existing = join(output, "不可覆盖.docx");
  await writeFile(existing, "existing target");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, existing);
  await writeFile(join(vault, "错误.md"), "# 错误定位\n\n$\\unknownNoemori{x}$\n");
  const request: ExportRequest = {
    root: vault,
    format: "docx",
    scope: { kind: "selection", paths: ["错误.md"] },
  };
  const failed = await page.evaluate((value) => window.noemori.reader.exportRun(value), request);
  expect(failed.status).toBe("failed");
  if (failed.status === "failed")
    expect(failed.issues).toContainEqual(
      expect.objectContaining({ path: "错误.md", line: 3, severity: "error" }),
    );
  expect(await readFile(existing, "utf8")).toBe("existing target");
  await writeFile(
    join(vault, "依赖缺失.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>.x{fill:url(relative.svg#paint)}</style><rect class="x" width="100" height="100"/></svg>',
  );
  await writeFile(join(vault, "错误.md"), "![[依赖缺失.svg]]\n");
  const missingSvg = await page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    request,
  );
  expect(missingSvg.status).toBe("failed");
  expect(await readFile(existing, "utf8")).toBe("existing target");
  const cancelled = await page.evaluate(
    async (value) => {
      const running = window.noemori.reader.exportRun(value);
      const accepted = await window.noemori.reader.exportCancel();
      return { accepted, result: await running };
    },
    { root: vault, format: "archive", scope: { kind: "vault" } } satisfies ExportRequest,
  );
  expect(cancelled.accepted).toBe(true);
  expect(cancelled.result.status).toBe("cancelled");
  expect(await readFile(existing, "utf8")).toBe("existing target");
  const restored = join(directory, "restored-vault");
  await mkdir(restored);
  for (const [path, bytes] of Object.entries(archive)) {
    if (!path.startsWith("vault/")) continue;
    const relative = path.slice("vault/".length);
    if (!relative) continue;
    const target = join(restored, relative);
    if (path.endsWith("/")) await mkdir(target, { recursive: true });
    else {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, restored);
  await runCommand(app, "open-vault");
  await expect
    .poll(async () => {
      const value: unknown = JSON.parse(await readFile(join(data, "session.json"), "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("reader" in value) ||
        typeof value.reader !== "object" ||
        value.reader === null ||
        !("vaultRoot" in value.reader)
      )
        return null;
      return value.reader.vaultRoot;
    })
    .toBe(restored);
  await rm(vault, { recursive: true });
  const restoredNote = await page.evaluate(async () =>
    Array.from(await window.noemori.reader.fileRead("验收.md")),
  );
  expect(new TextDecoder().decode(new Uint8Array(restoredNote))).toContain("LATEST-EXPORT");
  expect(await page.evaluate(() => window.noemori.reader.bookmarksList())).toEqual([
    { kind: "file", path: "验收.md", title: "恢复验收书签" },
  ]);
  const restoredBoard = await page.evaluate(async () =>
    Array.from(await window.noemori.reader.fileRead("白板.noemoriboard")),
  );
  expect(new Uint8Array(restoredBoard)).toEqual(archive["vault/白板.noemoriboard"]);
  expect(errors).toEqual([]);
}, 240000);

async function runCommand(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, action) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(action);
    if (!item) throw new Error(`命令不存在：${action}`);
    item.click();
  }, id);
}

test("EXP-COMMIT 覆盖确认绑定事前捕获的目标身份，确认期间替换目标必须整批失败", async (t) => {
  const { app, page, request, destination } = await launchExportApp(t, {
    "a.md": "# 已冻结的正文\n",
  });
  const target = await destination("overwrite.pdf");
  await writeFile(target, "old target");
  await app.evaluate(({ dialog }, target) => {
    dialog.showMessageBox = async () => {
      process
        .getBuiltinModule("node:fs")
        .writeFileSync(target, "external replacement during confirmation");
      return { response: 0, checkboxChecked: false };
    };
  }, target);
  const changed = await page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    request("pdf", ["a.md"]),
  );
  expect(changed.status).toBe("failed");
  if (changed.status === "failed")
    expect(changed.issues.map((issue) => issue.message).join(" ")).toContain(
      "目标文件或目录已被其他操作修改",
    );
  expect(await readFile(target, "utf8")).toBe("external replacement during confirmation");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const cancelled = await page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    request("pdf", ["a.md"]),
  );
  expect(cancelled.status).toBe("cancelled");
  expect(await readFile(target, "utf8")).toBe("external replacement during confirmation");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  const saved = await page.evaluate(
    (value) => window.noemori.reader.exportRun(value),
    request("pdf", ["a.md"]),
  );
  expect(saved.status).toBe("saved");
  expect((await readFile(target)).subarray(0, 5).toString()).toBe("%PDF-");
});
