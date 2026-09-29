import { spawn } from "node:child_process";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { closeTestProcess } from "../../support/process-cleanup";

it("正常退出会等待真实子进程结束", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  await closeTestProcess(child, async () => {
    child.kill("SIGTERM");
  });
  expect(child.signalCode).toBe("SIGTERM");
  await closeTestProcess(child, async () => {
    throw new Error("不能再次关闭");
  });
});

it("关闭入口挂起时强制回收，但向测试报告失败", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  await expect(closeTestProcess(child, () => new Promise(() => {}), 30)).rejects.toThrow(
    "未在期限内退出",
  );
  expect(child.signalCode).toBe("SIGKILL");
});

it("跨 realm 的 ESRCH 仍表示进程已释放，不能误报清理失败", async () => {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  await once(child, "exit");
  const missing: unknown = runInNewContext(
    "Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })",
  );
  expect(missing instanceof Error).toBe(false);
  const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
    throw missing;
  });
  try {
    await closeTestProcess(child, async () => {
      throw new Error("不能再次关闭");
    });
  } finally {
    kill.mockRestore();
  }
});

it("退出期间的 EPERM 表示进程组尚在回收，必须继续确认最终消失", async () => {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  await once(child, "exit");
  const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const missing = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  const kill = vi
    .spyOn(process, "kill")
    .mockImplementationOnce(() => {
      throw denied;
    })
    .mockImplementationOnce(() => {
      throw denied;
    })
    .mockImplementationOnce(() => {
      throw missing;
    });
  try {
    await closeTestProcess(child, async () => {
      throw new Error("不能再次关闭");
    });
    expect(kill).toHaveBeenCalledTimes(3);
  } finally {
    kill.mockRestore();
  }
});

it.skipIf(process.platform === "win32")("父进程退出不能掩盖进程组内残留的子进程", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    worker.once('spawn', () => process.stdout.write('ready'));
    setInterval(() => {}, 1000);
  `,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (child.stdout === null) throw new Error("缺少就绪通道");
  await once(child.stdout, "data");
  const failure = await closeTestProcess(
    child,
    async () => {
      child.kill("SIGTERM");
    },
    100,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  if (failure instanceof AggregateError) throw failure;
  expect(() => {
    throw failure;
  }).toThrow("进程组仍有子进程存活");
  expect(child.pid).toBeDefined();
  expect(() => process.kill(-child.pid!, 0)).toThrow();
});
