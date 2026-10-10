import { readdirSync, readFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import desktopPackage from "./package.json";

// 构建可由仓库根或桌面目录发起；入口、资源和运行依赖都必须归属当前配置所在项目。
const desktopRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runtimeDependencies = Object.keys(desktopPackage.dependencies);
const mathjaxWoffDir = resolve(desktopRoot, "node_modules/@mathjax/mathjax-newcm-font/chtml/woff2");
const mathjaxWoffPublic = "mathjax-fonts/woff2";
const require = createRequire(import.meta.url);

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
    root: desktopRoot,
    plugins: [
      externalizeDepsPlugin({ include: runtimeDependencies }),
      {
        name: "bundled-agent",
        writeBundle() {
          cpSync(
            join(require.resolve("@noemori/agent-node/package.json"), "../runtime"),
            resolve(desktopRoot, "out/main/agent"),
            { recursive: true },
          );
        },
      },
      {
        name: "bundled-pandoc",
        writeBundle() {
          cpSync(
            resolve(desktopRoot, ".cache/pandoc-3.12/bundle"),
            resolve(desktopRoot, "out/main/pandoc"),
            {
              recursive: true,
            },
          );
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "src/main/index.ts"),
          "whiteboard-worker": resolve(
            desktopRoot,
            "src/features/reader/main/whiteboard-worker.ts",
          ),
          "export-worker": resolve(desktopRoot, "src/features/reader/main/export/worker.ts"),
        },
      },
    },
    resolve: {
      external: ["@noemori/vault-node", "@noemori/agent-node"],
    },
  },
  preload: {
    root: desktopRoot,
    plugins: [externalizeDepsPlugin({ include: runtimeDependencies })],
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
    root: resolve(desktopRoot, "src/renderer"),
    build: {
      // 字体按独立文件加载，避免小分片被内联为现有 font-src 不允许的 data URL。
      assetsInlineLimit: (path) => (/\.(woff2?|ttf|otf)$/i.test(path) ? false : undefined),
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "src/renderer/index.html"),
          export: resolve(desktopRoot, "src/renderer/export.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@app": resolve(desktopRoot, "src/renderer"),
        "@reader": resolve(desktopRoot, "src/features/reader"),
        "@shared": resolve(desktopRoot, "src/shared"),
        "#js": resolve(desktopRoot, "node_modules/@mathjax/src/mjs"),
        "#default-font": resolve(desktopRoot, "node_modules/@mathjax/mathjax-newcm-font/mjs"),
      },
    },
    plugins: [
      svelte(),
      mathjaxWoffPlugin(),
      // PDF 的 CJK 字形映射、标准字体和解码器在开发与离线构建中使用同一目录。
      viteStaticCopy({
        targets: [
          ...["cmaps", "standard_fonts", "wasm", "iccs"].map((directory) => ({
            src: resolve(desktopRoot, `node_modules/pdfjs-dist/${directory}`),
            dest: "pdfjs",
          })),
          // 离线字体的版权与许可随构建一起分发。
          ...["lora", "newsreader", "inter", "noto-serif-sc", "noto-sans-sc"].map((font) => ({
            src: resolve(desktopRoot, `node_modules/@fontsource-variable/${font}/LICENSE`),
            dest: "font-licenses",
            rename: `${font}-OFL.txt`,
          })),
        ],
      }),
    ],
  },
});
