import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = join(import.meta.dirname, "../../../../../modules/notes/packages/desktop");

/**
 * 沙箱 preload 只能当普通脚本跑，不能用 ESM `import`。
 * 构建必须产出 CJS，主进程也必须加载对应文件。
 */
describe("sandboxed preload", () => {
  it("builds preload as CommonJS instead of ESM .mjs", () => {
    const vite = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
    expect(vite).toMatch(/format:\s*["']cjs["']/);

    const main = readFileSync(join(desktopRoot, "src/main/index.ts"), "utf8");
    expect(main).toMatch(/preload\/index\.cjs/);
    expect(main).not.toMatch(/preload\/index\.mjs/);
  });
});
