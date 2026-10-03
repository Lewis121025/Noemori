import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Rust 测试位于仓库根目录，保留相对层级的独立副本才能验证实际测试目标。
const source = fileURLToPath(new URL("../../../../", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), "noemori-rust-mutation-"));
if ((await realpath(source)) === (await realpath(sandbox))) throw new Error("禁止在工作区变异源码");
try {
  for (const relative of [
    "modules/notes/Cargo.toml",
    "modules/notes/Cargo.lock",
    "test/notes/vault",
    "test/notes/runtime",
  ]) {
    const target = join(sandbox, relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, relative), target, { recursive: true });
  }
  for (const name of ["runtime", "vault", "vault-node"]) {
    const relative = `modules/notes/packages/${name}`;
    const target = join(sandbox, relative);
    await mkdir(target, { recursive: true });
    await cp(join(source, relative, "Cargo.toml"), join(target, "Cargo.toml"));
    await cp(join(source, relative, "src"), join(target, "src"), { recursive: true });
    if (name === "vault-node")
      await cp(join(source, relative, "build.rs"), join(target, "build.rs"));
  }
  const report = join(source, "modules/notes/.artifacts/export-rust-mutation");
  await mkdir(report, { recursive: true });
  const args = [
    "mutants",
    "--manifest-path",
    join(sandbox, "modules/notes/Cargo.toml"),
    "--in-place",
    "--profile",
    "release",
    "--timeout",
    "120",
    "--build-timeout",
    "300",
    "--output",
    report,
    "--test-package",
    "noemori-runtime",
    "--test-package",
    "noemori-vault",
  ];
  for (const pattern of [
    "packages/runtime/src/export*",
    "packages/runtime/src/export/**",
    "packages/vault/src/export*",
    "packages/vault/src/export/**",
  ])
    args.push("--file", pattern);
  args.push("--", "export");
  const code = await new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd: sandbox, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      signal ? reject(new Error(`Rust 变异测试被 ${signal} 中断`)) : resolve(code ?? 1),
    );
  });
  process.exitCode = code;
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
