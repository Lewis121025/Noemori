import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const desktop = join(root, "modules/notes/packages/desktop");
const require = createRequire(join(desktop, "package.json"));
const run = promisify(execFile);

it("从仓库根构建仍使用桌面项目入口，Node 可选依赖由原包管理，不被提升为启动错误", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-build-directory-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "build.mjs"),
    output = join(directory, "main");
  await writeFile(
    script,
    `
import { resolveConfig } from ${JSON.stringify(pathToFileURL(require.resolve("electron-vite")).href)};
import { build } from ${JSON.stringify(pathToFileURL(require.resolve("vite")).href)};
import { readFile } from "node:fs/promises";
const { config } = await resolveConfig({ root: ${JSON.stringify(desktop)}, configFile: ${JSON.stringify(join(desktop, "electron.vite.config.ts"))}, logLevel: "silent" }, "build");
if (!config?.main || !config.preload || !config.renderer) throw new Error("构建配置不完整");
const main = config.main;
main.plugins = main.plugins.filter(plugin => !["bundled-agent", "bundled-pandoc"].includes(plugin.name));
main.build = { ...main.build, outDir: ${JSON.stringify(output)}, emptyOutDir: true };
await build(main);
const bundle = await readFile(${JSON.stringify(join(output, "index.js"))}, "utf8");
console.log(JSON.stringify({
  roots: [main.root, config.preload.root, config.renderer.root],
  optionalPeerError: bundle.includes("__viteOptionalPeerDep"),
  externalWebSocket: /from ["']ws["']/.test(bundle),
}));
`,
  );
  const result = await run(process.execPath, [script], {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 512 * 1024,
  });
  const report: unknown = JSON.parse(result.stdout.trim());
  expect(report).toEqual({
    roots: [desktop, desktop, join(desktop, "src/renderer")],
    optionalPeerError: false,
    externalWebSocket: true,
  });
}, 25_000);
