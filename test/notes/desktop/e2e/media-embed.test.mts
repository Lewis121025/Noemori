import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

/** 生成 2 秒的 8 kHz 单声道静音 WAV，作为可解码的真实音频文件。 */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("音频嵌入经流式协议加载并可拖动进度，编辑前后原文逐字节保留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-media-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "录音"), { recursive: true }), mkdir(userData)]);
  const source = "# 会议\n\n![[会议 记录.wav]]\n";
  await Promise.all([
    writeFile(join(vault, "笔记.md"), source),
    writeFile(join(vault, "录音", "会议 记录.wav"), silentWav(2)),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "笔记.md", filesCollapsed: false, leftWidth: 260 },
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
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "笔记.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    const audio = page.locator(".media-audio audio");
    await audio.waitFor({ state: "attached" });
    expect(await audio.getAttribute("src")).toMatch(/^noemori-vault:\/\/vault\//);
    // 元数据经协议读到：时长约 2 秒。
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration))
      .toBeCloseTo(2, 1);
    // 拖动进度依赖 Range 请求：跳到 1.5 秒后仍可继续读取。
    const seeked = await audio.evaluate(
      (element: HTMLAudioElement) =>
        new Promise<number>((resolve, reject) => {
          element.addEventListener("seeked", () => resolve(element.currentTime), { once: true });
          element.addEventListener("error", () => reject(new Error("播放器报错")), { once: true });
          element.currentTime = 1.5;
        }),
    );
    expect(seeked).toBeCloseTo(1.5, 1);

    await page.locator(".ProseMirror h1").click();
    await page.keyboard.press("End");
    await page.keyboard.type("纪要");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "笔记.md"), "utf8"))
      .toBe(source.replace("# 会议", "# 会议纪要"));

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
