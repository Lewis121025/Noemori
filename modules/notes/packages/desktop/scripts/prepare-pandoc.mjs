import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, cp, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync, zipSync } from "fflate";
import { wordTextStyle } from "../src/features/reader/shared/markdown/word-text-style.ts";

// 只在构建期下载固定摘要的上游产物；应用启动不访问网络，也不搜索系统 PATH。
const directory = fileURLToPath(new URL("../.cache/pandoc-3.12/", import.meta.url));
const artifacts = [
  [
    "pandoc.zip",
    "https://github.com/jgm/pandoc/releases/download/3.12/pandoc-3.12-arm64-macOS.zip",
    "f148ca09c9f36594db527a9fc988ad736290ce428f79594c50208cd1ec58b3c0",
  ],
  [
    "source.tar.gz",
    "https://codeload.github.com/jgm/pandoc/tar.gz/refs/tags/3.12",
    "b19c416525f00e2c35a75dc377c767a57084ac22a9f1f4f9c5f6448dabe9819e",
  ],
];
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("当前锁定的导出引擎仅支持 macOS arm64 构建");
await mkdir(directory, { recursive: true });
for (const [name, url, digest] of artifacts) {
  const path = join(directory, name);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`下载 Pandoc 失败：${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error(`Pandoc 构建资源摘要不符：${name}`);
  await writeFile(path + ".part", bytes);
  await rename(path + ".part", path);
}
const output = join(directory, "bundle");
await mkdir(output, { recursive: true });
const unpack = join(directory, "unpack");
await mkdir(unpack, { recursive: true });
try {
  execFileSync("/usr/bin/ditto", ["-x", "-k", join(directory, "pandoc.zip"), unpack]);
  execFileSync("/usr/bin/tar", ["-xzf", join(directory, "source.tar.gz"), "-C", unpack]);
  await cp(join(unpack, "pandoc-3.12-arm64/bin/pandoc"), join(output, "pandoc"));
  await chmod(join(output, "pandoc"), 0o755);
  for (const name of ["COPYING.md", "COPYRIGHT"])
    await cp(join(unpack, "pandoc-3.12", name), join(output, name));
  await cp(join(directory, "source.tar.gz"), join(output, "pandoc-3.12-source.tar.gz"));
  const version = execFileSync(join(output, "pandoc"), ["--version"], { encoding: "utf8" });
  if (!version.startsWith("pandoc 3.12\n")) throw new Error("随包 Pandoc 版本不符");
  // Word 只能应用一个字符样式；有限配色组合同时承载前景、背景与代码字体。
  const reference = unzipSync(execFileSync(join(output, "pandoc"), ["--print-default-data-file=reference.docx"]));
  const styles = reference["word/styles.xml"];
  if (!styles) throw new Error("Pandoc 默认 Word 模板缺少样式");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(styles).trimEnd();
  const closing = "</w:styles>";
  if (!xml.endsWith(closing)) throw new Error("Pandoc 默认 Word 模板结构变化");
  const palette = JSON.parse(await readFile(new URL("../src/features/reader/shared/markdown/text-palette.json", import.meta.url), "utf8"));
  const characterStyles = [];
  for (const text of [null, ...Object.keys(palette.text)]) {
    for (const highlight of [null, ...Object.keys(palette.highlight)]) {
      if (text === null && highlight === null) continue;
      for (const code of [false, true]) {
        const name = wordTextStyle(text, highlight, code);
        const properties = (text ? `<w:color w:val="${palette.text[text].light.slice(1)}"/>` : "") + (highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${palette.highlight[highlight].light.slice(1)}"/>` : "");
        characterStyles.push(`<w:style w:type="character" w:customStyle="1" w:styleId="${name}"><w:name w:val="${name}"/><w:basedOn w:val="${code ? "VerbatimChar" : "DefaultParagraphFont"}"/><w:rPr>${properties}</w:rPr></w:style>`);
      }
    }
  }
  reference["word/styles.xml"] = new TextEncoder().encode(xml.slice(0, -closing.length) + characterStyles.join("") + closing);
  await writeFile(join(output, "reference.docx"), zipSync(reference, { mtime: new Date(2000, 0, 1) }));
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        version: "3.12",
        artifacts: artifacts.map(([name, url, sha256]) => ({ name, url, sha256 })),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(unpack, { recursive: true, force: true });
}
