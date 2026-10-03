import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: fileURLToPath(new URL("../modules/notes/packages/desktop/", import.meta.url)),
  plugins: [svelte({ compilerOptions: { hmr: false } })],
  resolve: {
    // vitest 默认走 svelte 的 server 入口，mount/$effect 会报 lifecycle_function_unavailable
    conditions: ["browser"],
    alias: {
      ...(process.env["NOEMORI_MUTATION_SOURCE"]
        ? {
            "@noemori/vault-node": fileURLToPath(
              new URL("../modules/notes/packages/vault-node/index.js", import.meta.url),
            ),
          }
        : {}),
      // 仓库根部的主进程测试与应用使用同一 Electron 模块，确保 mock 命中。
      electron: fileURLToPath(
        new URL(
          "../modules/notes/packages/desktop/node_modules/electron/index.js",
          import.meta.url,
        ),
      ),
      // PDF 渲染的故障注入必须命中应用实际加载的模块，避免根目录解析到另一个模块 ID。
      "pdfjs-dist": fileURLToPath(
        new URL("../modules/notes/packages/desktop/node_modules/pdfjs-dist", import.meta.url),
      ),
      // 导出页面的图表故障注入与应用实际加载的 Mermaid 保持同一模块身份。
      mermaid: fileURLToPath(
        new URL("../modules/notes/packages/desktop/node_modules/mermaid", import.meta.url),
      ),
      "@cantoo/pdf-lib": fileURLToPath(
        new URL("../modules/notes/packages/desktop/node_modules/@cantoo/pdf-lib", import.meta.url),
      ),
      "@reader": fileURLToPath(
        new URL("../modules/notes/packages/desktop/src/features/reader", import.meta.url),
      ),
      "@app": fileURLToPath(
        new URL("../modules/notes/packages/desktop/src/renderer", import.meta.url),
      ),
    },
  },
  test: {
    include: ["../../../../test/**/*.test.ts"],
    environment: "node",
  },
});
