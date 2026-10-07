import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 浏览器运行材料自包含；发布目录不依赖开发者的 node_modules 或用户的浏览器缓存。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "runtime/browser");
const web = resolve(root, "../web-runtime");
const require = createRequire(join(web, "package.json"));
const playwright = dirname(require.resolve("playwright-core/package.json"));
const build = spawnSync("pnpm", ["--filter", "@noemori/agent-web-runtime", "build"], {
  cwd: root,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(runtime, { recursive: true });
cpSync(join(web, "dist/browser"), join(runtime, "browser"), { recursive: true });
cpSync(join(web, "dist/network.js"), join(runtime, "network.js"));
cpSync(playwright, join(runtime, "node_modules/playwright-core"), { recursive: true });
cpSync(dirname(require.resolve("mime/package.json")), join(runtime, "node_modules/mime"), {
  recursive: true,
});
writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true, type: "module" }));
const browsers = join(runtime, "browsers");
const installed = spawnSync(process.execPath, [join(playwright, "cli.js"), "install", "chromium"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  stdio: "inherit",
});
if (installed.error) throw installed.error;
if (installed.status !== 0) process.exit(installed.status ?? 1);
const executable = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import {chromium} from 'playwright-core'; process.stdout.write(chromium.executablePath());",
  ],
  { cwd: runtime, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, encoding: "utf8" },
);
if (executable.error) throw executable.error;
if (executable.status !== 0) throw new Error(executable.stderr);
writeFileSync(
  join(runtime, "browser.json"),
  JSON.stringify({
    executable: relative(runtime, executable.stdout),
    playwright: JSON.parse(readFileSync(join(playwright, "package.json"), "utf8")).version,
  }),
);
