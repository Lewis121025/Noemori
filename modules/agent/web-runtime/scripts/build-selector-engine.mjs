import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// 固定引擎只从已锁定的正式包取得；升级时必须重新验证构造器和查询契约。
const require = createRequire(import.meta.url);
const version = require("playwright-core/package.json").version;
if (version !== "1.63.0") throw new Error(`语义定位引擎版本未验收：${version}`);
const bundle = readFileSync(require.resolve("playwright-core/lib/coreBundle"), "utf8");
const marker = "// packages/playwright-core/src/generated/injectedScriptSource.ts";
const section = bundle.slice(bundle.indexOf(marker));
const literal = section.match(/^    source\d+ = ('[^\n]*');$/m)?.[1];
if (!bundle.includes(marker) || !literal) throw new Error("正式 Playwright 包缺少固定选择引擎资源");
// 仅解码受信赖安装包的字符串字面量；没有任何工具参数参与此构建过程。
const source = runInNewContext(literal, Object.create(null), { timeout: 1000 });
if (
  typeof source !== "string" ||
  !source.includes("querySelectorAll(selector") ||
  !source.includes("parseSelector(selector")
)
  throw new Error("Playwright 固定选择引擎接口变化，拒绝构建");
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/browser");
mkdirSync(directory, { recursive: true });
writeFileSync(
  resolve(directory, "selector-engine.js"),
  `export const selectorEngineSource = ${JSON.stringify(source)};\nexport const selectorEngineVersion = ${JSON.stringify(version)};\n`,
);
