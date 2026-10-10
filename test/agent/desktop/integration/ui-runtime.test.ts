import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { installUiRuntime } from "../../../../modules/notes/packages/desktop/src/features/agent/main/ui-runtime";

const home = vi.hoisted(() => ({ path: "" }));
const unsupported = process.platform !== "darwin" && process.platform !== "linux";
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.path,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
}));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "noemori-ui-installation-"));
  // 安装测试的浏览器登记目录也归夹具拥有，不访问使用者的真实主目录。
  home.path = join(directory, "home");
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const assets = join(directory, "assets");
  await mkdir(join(assets, "browser-extension"), { recursive: true });
  await writeFile(
    join(assets, "browser-extension/manifest.json"),
    await readFile(
      new URL("../../../../modules/agent/web-runtime/src/extension/manifest.json", import.meta.url),
    ),
  );
  await writeFile(join(assets, "noemori-browser-host"), "本代桥接文件");
  await chmod(join(assets, "noemori-browser-host"), 0o755);
  const userData = join(directory, "app");
  const launcher = join(assets, "terminal-sandbox");
  const bridge = join(userData, "ui/noemori-browser-host");
  await mkdir(join(userData, "ui"), { recursive: true });
  await writeFile(bridge, "既有桥接文件");
  return { userData, launcher, bridge };
}

it.skipIf(unsupported)(
  "完整安装桥接与 Chrome、Edge 登记文件，所有临时副本均已转交目标路径",
  async () => {
    const { userData, launcher, bridge } = await fixture();
    const installed = await installUiRuntime(userData, launcher);
    expect(installed.installed).toBe(true);
    expect(await readFile(bridge, "utf8")).toBe("本代桥接文件");
    expect(await readdir(join(userData, "ui"))).toEqual(["noemori-browser-host"]);
    const homes =
      process.platform === "darwin"
        ? [
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/Microsoft Edge",
          ]
        : [".config/google-chrome", ".config/microsoft-edge"];
    for (const browser of homes) {
      const directory = join(home.path, browser, "NativeMessagingHosts");
      expect(await readdir(directory)).toEqual(["app.noemori.browser.json"]);
      expect(
        JSON.parse(await readFile(join(directory, "app.noemori.browser.json"), "utf8")),
      ).toMatchObject({
        path: bridge,
        allowed_origins: ["chrome-extension://adeahajhgekfhfgimpaokoahfajebajb/"],
      });
    }
  },
);

it.skipIf(unsupported)(
  "桥接临时路径被占用时拒绝安装，不覆盖或删除占用者，也不改写既有入口",
  async () => {
    const { userData, launcher, bridge } = await fixture();
    const identity = "11111111-1111-4111-8111-111111111111";
    const temporary = `${bridge}.${identity}.tmp`;
    await writeFile(temporary, "其他操作持有的文件");
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(identity);

    await expect(installUiRuntime(userData, launcher)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(temporary, "utf8")).toBe("其他操作持有的文件");
    expect(await readFile(bridge, "utf8")).toBe("既有桥接文件");
  },
);

it.skipIf(unsupported).each([false, true])(
  "桥接替换失败保留旧入口，清理也失败=%s 时交付两处原因",
  async (cleanupFails) => {
    const { userData, launcher, bridge } = await fixture();
    const failure = new Error("桥接替换失败");
    const cleanup = new Error("桥接临时文件清理失败");
    vi.spyOn(files, "rename").mockRejectedValueOnce(failure);
    if (cleanupFails) vi.spyOn(files, "rm").mockRejectedValueOnce(cleanup);

    const installing = installUiRuntime(userData, launcher);
    if (cleanupFails)
      await expect(installing).rejects.toMatchObject({ errors: [failure, cleanup] });
    else await expect(installing).rejects.toBe(failure);
    expect(await readFile(bridge, "utf8")).toBe("既有桥接文件");
    expect(await readdir(join(userData, "ui"))).toHaveLength(cleanupFails ? 2 : 1);
  },
);
