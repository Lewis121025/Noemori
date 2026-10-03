import { spawn } from "node:child_process";

// 系统级最大 RSS 包括测试子进程；独立于产物断言，超出预算必须让验收失败。
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("规模验收基线要求 macOS arm64");
const child = spawn("/usr/bin/time", ["-l", "cargo", "test", "--release", "--locked", "--manifest-path", "modules/notes/Cargo.toml", "-p", "noemori-runtime", "--lib", "export::tests::stress", "--", "--ignored", "--nocapture", "--test-threads=1"], { stdio: ["ignore", "inherit", "pipe"] });
let diagnostics = "";
child.stderr.on("data", (chunk) => { process.stderr.write(chunk); diagnostics = (diagnostics + chunk.toString("utf8")).slice(-65536); });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => {
  const peak = /([0-9]+)\s+maximum resident set size/.exec(diagnostics)?.[1];
  if (code !== 0 || peak === undefined || Number(peak) > 2 * 1024 ** 3) {
    console.error(`导出压力验收未通过：退出码 ${code}，峰值 RSS ${peak ?? "未知"} 字节，要求 ≤ 2 GiB。`);
    process.exitCode = 1;
  } else console.log(`导出压力与持久运行通过；峰值 RSS ${(Number(peak) / 1024 ** 2).toFixed(1)} MiB。`);
});
