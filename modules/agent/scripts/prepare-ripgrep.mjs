import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 只在构建期准备固定版本；运行时的工具及许可证随 Rust 产物分发。
const version = "15.2.0";
const artifacts = {
  "aarch64-apple-darwin": [
    "aarch64-apple-darwin",
    "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  ],
  "x86_64-apple-darwin": [
    "x86_64-apple-darwin",
    "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  ],
  "aarch64-unknown-linux-gnu": [
    "aarch64-unknown-linux-gnu",
    "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
  ],
  "x86_64-unknown-linux-gnu": [
    "x86_64-unknown-linux-musl",
    "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  ],
  "x86_64-unknown-linux-musl": [
    "x86_64-unknown-linux-musl",
    "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  ],
};
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const target = process.argv[2] ?? process.env.CARGO_BUILD_TARGET ?? host;
if (!Object.hasOwn(artifacts, target)) throw new Error(`内置 ripgrep 尚不支持目标平台：${target}`);
const [platform, digest] = artifacts[target];
const name = `ripgrep-${version}-${platform}`;
const cache = fileURLToPath(new URL(`../.cache/ripgrep/${target}/`, import.meta.url));
await mkdir(cache, { recursive: true });
const archive = join(cache, `${name}.tar.gz`);
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(
    `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${name}.tar.gz`,
    {
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok) throw new Error(`下载 ripgrep 失败：${response.status}`);
  bytes = new Uint8Array(await response.arrayBuffer());
}
if (createHash("sha256").update(bytes).digest("hex") !== digest) {
  throw new Error(`ripgrep 构建资源摘要不符：${archive}`);
}
// 唯一暂存目录避免并行构建共用半写入文件；校验通过后才发布资源。
const staging = await mkdtemp(join(cache, "prepare-"));
try {
  const verified = join(staging, "archive.tar.gz");
  await writeFile(verified, bytes);
  execFileSync("tar", [
    "-xzf",
    verified,
    "-C",
    staging,
    `${name}/rg`,
    `${name}/COPYING`,
    `${name}/LICENSE-MIT`,
    `${name}/UNLICENSE`,
  ]);
  const executable = join(staging, name, "rg");
  await chmod(executable, 0o755);
  if (target === host) {
    const output = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (!output.startsWith(`ripgrep ${version} `) && !output.startsWith(`ripgrep ${version}\n`)) {
      throw new Error("内置 ripgrep 版本不符");
    }
  }
  const licenses = await Promise.all(
    ["COPYING", "LICENSE-MIT", "UNLICENSE"].map(
      async (file) => `${file}\n\n${await readFile(join(staging, name, file), "utf8")}`,
    ),
  );
  await writeFile(join(staging, "LICENSE-ripgrep"), licenses.join("\n\n"));
  await writeFile(join(staging, "VERSION"), version);
  // 内容未变时保留 mtime，避免每次 pnpm check/test 都重编译嵌入资源。
  for (const [source, destination] of [
    [verified, archive],
    [executable, join(cache, "rg")],
    [join(staging, "LICENSE-ripgrep"), join(cache, "LICENSE-ripgrep")],
    [join(staging, "VERSION"), join(cache, "VERSION")],
  ]) {
    let previous;
    try {
      previous = await readFile(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous?.equals(await readFile(source))) continue;
    await rename(source, destination);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
