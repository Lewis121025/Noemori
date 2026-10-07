import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// 原生绑定与沙箱启动器来自同一源码代次；调试和发布均准备可直接加载的完整运行材料。
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("cargo", ["build", "--manifest-path", "../Cargo.toml", "--locked", "--bin", "noemori-terminal-sandbox", ...(release ? ["--release"] : [])]);
run("pnpm", ["exec", "napi", "build", "--platform", ...(release ? ["--release"] : [])]);
mkdirSync(join(directory, "runtime"), { recursive: true });
const target = process.env.CARGO_TARGET_DIR ? resolve(directory, process.env.CARGO_TARGET_DIR) : resolve(directory, "../target");
const executable = process.platform === "win32" ? "noemori-terminal-sandbox.exe" : "noemori-terminal-sandbox";
copyFileSync(join(target, release ? "release" : "debug", executable), join(directory, "runtime", executable));
run(process.execPath, [join(directory, "scripts", "prepare-browser.mjs")]);
