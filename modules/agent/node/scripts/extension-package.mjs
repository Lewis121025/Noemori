import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 复制扩展实际依赖的已编译模块，保证浏览器隔离运行时不会加载 Node 专用源码。
 * @param web 已构建的 web-runtime 目录，必须包含 dist 与 src/extension。
 * @param extension 当前构建独占的扩展输出目录。
 * @returns 文件全部复制后返回；源文件缺失或写入失败时抛出文件系统错误。
 */
export function packageExtension(web, extension) {
  mkdirSync(join(extension, "browser"), { recursive: true });
  cpSync(join(web, "dist/extension"), join(extension, "extension"), {
    recursive: true,
  });
  for (const file of [
    "contract.js",
    "dom.js",
    "handoff.js",
    "observation-update.js",
    "semantic.js",
    "semantic-dom.js",
    "selector-engine.js",
    "extensions.js",
    "diagnostics.js",
    "webmcp.js",
  ])
    copyFileSync(
      join(web, "dist/browser", file),
      join(extension, "browser", file),
    );
  copyFileSync(
    join(web, "src/extension/popup.html"),
    join(extension, "extension/popup.html"),
  );
  copyFileSync(
    join(web, "src/extension/manifest.json"),
    join(extension, "manifest.json"),
  );
}
