import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** 启动真实控制管道；测试关闭输出消费端后仍负责等待并回收辅助进程。 */
export function outputPeer(t, entry) {
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += String(bytes);
  });
  // send 的写入回调负责拒绝 Promise；事件通路也保留诊断，避免 fixture 额外崩溃。
  child.stdin.on("error", (error) => {
    stderr += `宿主测试控制输入失败：${error.message}\n`;
  });
  const exited = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  return {
    child,
    frames: lines[Symbol.asyncIterator](),
    exited,
    stderr: () => stderr,
    send: (value) =>
      new Promise((resolve, reject) =>
        child.stdin.write(JSON.stringify(value) + "\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    disconnect: () => {
      lines.close();
      child.stdout.destroy();
    },
  };
}
