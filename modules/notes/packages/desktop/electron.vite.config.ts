import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const mathjaxWoffDir = resolve("node_modules/@mathjax/mathjax-newcm-font/chtml/woff2");
const mathjaxWoffPublic = "mathjax-fonts/woff2";

/**
 * 把 NewCM woff2 以原始文件名挂到固定 URL。
 *
 * MathJax 会用 `fontURL + '/' + 文件名` 拼 @font-face，不能走 Vite 哈希名，也不能走 CDN。
 */
function mathjaxWoffPlugin(): Plugin {
  return {
    name: "mathjax-woff",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const prefix = `/${mathjaxWoffPublic}/`;
        if (!url.startsWith(prefix)) {
          next();
          return;
        }
        const name = decodeURIComponent(
          (url.slice(prefix.length).split("?")[0] ?? "").replace(/\/+$/, ""),
        );
        if (name === "" || name.includes("..") || name.includes("/") || !name.endsWith(".woff2")) {
          next();
          return;
        }
        try {
          const data = readFileSync(join(mathjaxWoffDir, name));
          res.setHeader("Content-Type", "font/woff2");
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const name of readdirSync(mathjaxWoffDir)) {
        if (!name.endsWith(".woff2")) {
          continue;
        }
        this.emitFile({
          type: "asset",
          fileName: `${mathjaxWoffPublic}/${name}`,
          source: readFileSync(join(mathjaxWoffDir, name)),
        });
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "core-worker": resolve("src/main/core-worker.ts"),
        },
      },
    },
    resolve: {
      external: ["@nous/vault-node"],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // 沙箱 preload 只能当普通脚本执行，ESM `import` 会直接语法错误。
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@app": resolve("src/renderer"),
        "@reader": resolve("src/features/reader"),
        "@shared": resolve("src/shared"),
        "#js": resolve("node_modules/@mathjax/src/mjs"),
        "#default-font": resolve("node_modules/@mathjax/mathjax-newcm-font/mjs"),
      },
    },
    plugins: [
      svelte(),
      mathjaxWoffPlugin(),
      // PDF 的 CJK 字形映射、标准字体和解码器在开发与离线构建中使用同一目录。
      viteStaticCopy({
        targets: ["cmaps", "standard_fonts", "wasm", "iccs"].map((directory) => ({
          src: resolve(`node_modules/pdfjs-dist/${directory}`),
          dest: "pdfjs",
        })),
      }),
    ],
  },
});
