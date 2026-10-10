import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageExtension } from "../../../../modules/agent/node/scripts/extension-package.mjs";

test("实际扩展打包产物可加载，并包含所有模块的浏览器依赖", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-extension-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const web = fileURLToPath(
    new URL("../../../../modules/agent/web-runtime", import.meta.url),
  );
  packageExtension(web, directory);
  const page = await import(
    pathToFileURL(join(directory, "extension/page.js")).href
  );
  const browser = await import(
    pathToFileURL(join(directory, "extension/browser.js")).href
  );
  assert.equal(typeof page.ExtensionPage.prototype.observed, "function");
  assert.equal(typeof browser.ExtensionBrowser.prototype.execute, "function");
  for (const folder of ["browser", "extension"]) {
    for (const file of await readdir(join(directory, folder))) {
      if (!file.endsWith(".js")) continue;
      const path = join(directory, folder, file);
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
      )) {
        const specifier = match[1];
        assert.ok(
          specifier.startsWith("."),
          `${file} 不能依赖 Node 或未打包的外部模块 ${specifier}`,
        );
        const dependency = resolve(dirname(path), specifier);
        assert.ok(
          dependency.startsWith(`${directory}/`),
          `${file} 的依赖超出扩展根目录`,
        );
        await assert.doesNotReject(
          readFile(dependency),
          `${file} 缺少 ${specifier}`,
        );
      }
    }
  }
});
