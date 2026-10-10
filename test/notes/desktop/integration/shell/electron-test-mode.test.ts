import { beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { _electron as electron } from "playwright-core";
import "../../support/electron-lifecycle";

const runtime = vi.hoisted(() => ({
  launch: vi.fn(),
  evaluate: vi.fn(),
  close: vi.fn(),
  firstWindow: vi.fn(),
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
    showErrorBox: vi.fn(),
  },
}));
vi.mock("playwright-core", () => ({ _electron: { launch: runtime.launch } }));

beforeEach(() => {
  runtime.launch.mockClear();
  runtime.firstWindow.mockReset().mockResolvedValue({});
  runtime.evaluate.mockImplementation(async (callback) => callback({ dialog: runtime.dialog }));
  runtime.launch.mockResolvedValue({
    evaluate: runtime.evaluate,
    close: runtime.close,
    firstWindow: runtime.firstWindow,
    process: () => ({ exitCode: 0, signalCode: null }),
  });
});

it("桌面测试覆盖旧旅程的显式前台设置，从启动起在后台运行", async () => {
  await electron.launch({ args: ["/test/main.js"], env: { NOEMORI_TEST_WINDOW: "visible" } });
  expect(runtime.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ["/test/main.js", "--noerrdialogs"],
      env: expect.objectContaining({
        NOEMORI_TEST_WINDOW:
          process.platform === "linux"
            ? (process.env["NOEMORI_TEST_WINDOW"] ?? "visible")
            : "hidden",
      }),
    }),
  );
  expect(runtime.evaluate).toHaveBeenCalledOnce();
  expect(runtime.firstWindow).toHaveBeenCalledWith({ timeout: 15_000 });
});

it("主窗口未就绪时启动入口直接报告失败，不交付一个会让旅程继续挂起的应用", async () => {
  const failure = new Error("主窗口未就绪");
  runtime.firstWindow.mockRejectedValueOnce(failure);
  await expect(electron.launch({})).rejects.toBe(failure);
});

it("启动失败先关闭所属进程组，再交付原始失败，测试结束不会遗留子进程", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  const failure = new Error("测试注入的窗口加载失败");
  const close = vi.fn(async () => {
    child.kill("SIGTERM");
  });
  runtime.launch.mockResolvedValue({
    evaluate: runtime.evaluate,
    firstWindow: runtime.firstWindow,
    close,
    process: () => child,
  });
  runtime.firstWindow.mockRejectedValueOnce(failure);
  await expect(electron.launch({})).rejects.toBe(failure);
  expect(close).toHaveBeenCalledOnce();
  expect(child.signalCode).toBe("SIGTERM");
});

it("未模拟的系统弹窗明确报错，具体旅程仍能提供自己的选择结果", async () => {
  await electron.launch({});
  await expect(runtime.dialog.showOpenDialog()).rejects.toThrow("禁止打开系统弹窗");
  await expect(runtime.dialog.showSaveDialog()).rejects.toThrow("禁止打开系统弹窗");
  await expect(runtime.dialog.showMessageBox()).rejects.toThrow("禁止打开系统弹窗");
  expect(() => runtime.dialog.showErrorBox()).toThrow("禁止打开系统弹窗");
  runtime.dialog.showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
  expect(await runtime.dialog.showOpenDialog()).toEqual({ canceled: true, filePaths: [] });
});
