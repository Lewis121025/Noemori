import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));
const cycles = Number(process.env["NOUS_RESOURCE_CYCLES"] ?? "15");
if (!Number.isInteger(cycles) || cycles < 15 || cycles > 10000)
  throw new Error("资源循环次数必须为 15–10000 的整数");

declare global {
  interface Window {
    /** 仅在本测试窗口安装；保留计数以检查显式销毁，不写入应用文件。 */
    resourceAudit: { blobs: Set<string>; workers: Set<Worker> };
  }
}

test(
  "资源契约：反复挂载图片、PDF、图谱后释放资源，空闲不改写业务文件",
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nous-resource-contract-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const vault = join(root, "vault");
    const userData = join(root, "state");
    await Promise.all([mkdir(vault), mkdir(userData)]);
    const plain = "# Plain\n\n[[media]]\n";
    const media = "# Media\n\n![[preview.svg]]\n\n![[preview.pdf]]\n";
    await Promise.all([
      writeFile(join(vault, "plain.md"), plain),
      writeFile(join(vault, "media.md"), media),
      writeFile(
        join(vault, "preview.pdf"),
        await readFile(new URL("../fixtures/preview.pdf", import.meta.url)),
      ),
      writeFile(
        join(vault, "preview.svg"),
        await readFile(new URL("../fixtures/preview.svg", import.meta.url)),
      ),
      writeFile(
        join(userData, "session.json"),
        JSON.stringify({
          reader: { vaultRoot: vault, currentPath: "plain.md" },
          appearance: "light",
          window: null,
        }),
      ),
    ]);
    const executable: unknown = require("electron");
    if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name !== "ELECTRON_RENDERER_URL") env[name] = value;
    }
    const app = await electron.launch({
      executablePath: executable,
      args: [
        fileURLToPath(new URL("out/main/index.js", desktop)),
        `--user-data-dir=${userData}`,
        "--no-sandbox",
      ],
      env,
    });
    const child = app.process();
    const page = await app.firstWindow({ timeout: 15000 });
    page.setDefaultTimeout(15000);
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "plain.md" &&
        !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
    );
    await page.evaluate(() => {
      const blobs = new Set<string>();
      const workers = new Set<Worker>();
      window.resourceAudit = { blobs, workers };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (value) => {
        const url = create(value);
        blobs.add(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        blobs.delete(url);
        revoke(url);
      };
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args);
          workers.add(this);
        }
        override terminate(): void {
          workers.delete(this);
          super.terminate();
        }
      };
    });
    const cdp = await page.context().newCDPSession(page);
    const open = async (name: string) => {
      await page
        .getByRole("navigation", { name: "文件列表" })
        .getByRole("treeitem", { name, exact: true })
        .click();
      await page.waitForFunction(
        (path) =>
          document.querySelector(".document-name")?.textContent === path &&
          !document.querySelector("section[data-pane]")?.hasAttribute("inert"),
        name,
      );
    };
    const resources = () =>
      page.evaluate(() => ({
        blobs: window.resourceAudit.blobs.size,
        workers: window.resourceAudit.workers.size,
      }));
    const cycle = async () => {
      await open("media.md");
      await page.locator(".ProseMirror > p").last().scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          !!document.querySelector(".preview-stage:not(.concealed) canvas") &&
          !!document.querySelector<HTMLImageElement>("img.note-image")?.complete,
      );
      await expect.poll(resources).toEqual({ blobs: 1, workers: 1 });
      await open("plain.md");
      await expect.poll(resources).toEqual({ blobs: 0, workers: 0 });
      await page.keyboard.press("ControlOrMeta+g");
      await page.getByRole("region", { name: "关联空间" }).locator("canvas").waitFor();
      await expect.poll(async () => (await resources()).workers).toBe(1);
      await page.getByRole("button", { name: "阅读与写作", exact: true }).click();
      await expect.poll(resources).toEqual({ blobs: 0, workers: 0 });
    };
    const sample = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return {
        dom: await cdp.send("Memory.getDOMCounters"),
        heap: await cdp.send("Runtime.getHeapUsage"),
        processes: await app.evaluate(({ app }) =>
          app.getAppMetrics().map((metric) => ({
            type: metric.type,
            residentKiB: metric.memory.workingSetSize,
          })),
        ),
      };
    };
    for (let index = 0; index < (cycles > 100 ? 50 : 5); index++) await cycle();
    const baseline = await sample();
    const verify = (current: Awaited<ReturnType<typeof sample>>) => {
      expect(current.dom.documents).toBeLessThanOrEqual(baseline.dom.documents);
      expect(current.dom.nodes - baseline.dom.nodes).toBeLessThan(200);
      expect(current.dom.jsEventListeners - baseline.dom.jsEventListeners).toBeLessThan(20);
      expect(current.heap.usedSize - baseline.heap.usedSize).toBeLessThan(8 * 1024 * 1024);
      expect(current.processes.length).toBeLessThanOrEqual(baseline.processes.length);
      const browserMemory = (item: typeof current) =>
        item.processes.find((process) => process.type === "Browser")?.residentKiB ?? 0;
      expect(browserMemory(current) - browserMemory(baseline)).toBeLessThan(128 * 1024);
    };
    let after = baseline;
    for (let index = 0; index < cycles; index++) {
      await cycle();
      if ((index + 1) % 100 === 0 || index + 1 === cycles) {
        after = await sample();
        verify(after);
        if (cycles > 100)
          console.info(
            "持续资源观测",
            JSON.stringify({ completed: index + 1, total: cycles, sample: after }),
          );
      }
    }
    console.info("资源回归采样", JSON.stringify({ baseline, after }));
    // 精确资源计数是硬契约；DOM/堆留出 Chromium 与有界历史的正常波动余量。
    verify(after);
    expect(await readFile(join(vault, "plain.md"), "utf8")).toBe(plain);
    expect(await readFile(join(vault, "media.md"), "utf8")).toBe(media);
    const before = await readFile(join(userData, "session.json"));
    const beforeMetadata = await stat(join(userData, "session.json"), { bigint: true });
    // 对业务持久化入口计数的单元测试负责发现同内容重写；这里验证真实窗口的空闲状态。
    await page.waitForTimeout(1200);
    expect(await readFile(join(userData, "session.json"))).toEqual(before);
    const afterMetadata = await stat(join(userData, "session.json"), { bigint: true });
    expect(afterMetadata.mtimeNs).toBe(beforeMetadata.mtimeNs);
    expect(afterMetadata.ino).toBe(beforeMetadata.ino);
    await cdp.detach();
    await app.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  },
  Math.max(120000, cycles * 2000),
);
