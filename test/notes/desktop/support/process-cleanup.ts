import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Node 系统错误可能来自测试运行器的另一个 realm，按错误码判断正常的进程消失。 */
function hasSystemCode(error: unknown, code: "ESRCH" | "EPERM"): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function groupExists(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") return !exited(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (hasSystemCode(error, "ESRCH")) return false;
    // kill(0) 的 EPERM 仍表示组存在；macOS 回收孤儿进程时会短暂出现，继续等到 ESRCH。
    if (hasSystemCode(error, "EPERM")) return true;
    throw error;
  }
}

async function waitForGroupExit(child: ChildProcess, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (groupExists(child)) {
    if (Date.now() >= deadline) throw new Error("测试进程组仍有子进程存活");
    await delay(20);
  }
}

/** 在固定期限内等待，完成或失败都释放计时器，不留下 Promise.race 的悬空定时任务。 */
function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("测试进程未在期限内退出")), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 关闭由测试启动的独立进程组；异常时回收整组，但仍使测试失败。
 * @param child 必须由 detached 启动；Playwright 在 macOS/Linux 上使用独立进程组。
 * @param close 正常关闭入口，须完成产品自己的保存与资源释放。
 * @param timeoutMs 正常关闭期限；测试可缩短以注入故障。
 * @throws 正常关闭超时或失败；强制清理失败时合并错误，不伪装为正常退出。
 */
export async function closeTestProcess(
  child: ChildProcess,
  close: () => Promise<void>,
  timeoutMs = 5000,
): Promise<void> {
  const alreadyExited = exited(child);
  if (alreadyExited && !groupExists(child)) return;
  const exit = alreadyExited
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await within(
      Promise.resolve()
        .then(() => (alreadyExited ? undefined : close()))
        .then(() => exit),
      timeoutMs,
    );
    await waitForGroupExit(child, timeoutMs);
  } catch (error) {
    try {
      if (child.pid !== undefined) {
        if (process.platform === "win32") child.kill("SIGKILL");
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (cause) {
            if (!hasSystemCode(cause, "ESRCH")) throw cause;
          }
        }
      }
      await within(exit, 3000);
      await waitForGroupExit(child, 3000);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `测试进程关闭与清理均失败：${String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
