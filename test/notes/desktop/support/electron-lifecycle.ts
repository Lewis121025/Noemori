import { _electron as electron } from "playwright-core";
import { afterEach, beforeEach, vi } from "vitest";
import { closeTestProcess } from "./process-cleanup";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 所有桌面旅程共用清理边界，测试断言失败也不能绕过；临时目录在 onTestFinished 才删除。
const launch = electron.launch.bind(electron);
let cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanup = [];
  vi.spyOn(electron, "launch").mockImplementation(async (options) => {
    const argument = options?.args?.find((argument) => argument.startsWith("--user-data-dir="));
    const state = argument?.slice("--user-data-dir=".length);
    let root = state ? join(state, "Noemori") : undefined;
    if (state) {
      try {
        const value: unknown = JSON.parse(await readFile(join(state, "session.json"), "utf8"));
        const reader = typeof value === "object" && value !== null && "reader" in value ? value.reader : value;
        if (typeof reader === "object" && reader !== null && "vaultRoot" in reader && typeof reader.vaultRoot === "string") root = reader.vaultRoot;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    // 旧旅程的 fixture 根就是其应用仓库；新仓库旅程显式传入另一个根以验证迁移，所有测试都隔离用户 Documents。
    // 本机测试统一隐藏；Linux CI 仍由 Xvfb 映射窗口，不向用户桌面展示。
    const mode = process.platform === "linux" ? (process.env["NOEMORI_TEST_WINDOW"] ?? "visible") : "hidden";
    const timeout = options?.timeout ?? 15_000;
    const app = await launch({ ...options, timeout, args: [...(options?.args ?? []), "--noerrdialogs"], env: { ...process.env, ...options?.env, NOEMORI_TEST_WINDOW: mode, ...(root ? { NOEMORI_TEST_LIBRARY_ROOT: options?.env?.["NOEMORI_TEST_LIBRARY_ROOT"] ?? root } : {}) } });
    const child = app.process();
    const close = app.close.bind(app);
    let closing: Promise<void> | null = null;
    const finish = () => {
      closing ??= closeTestProcess(child, close);
      return closing;
    };
    cleanup.push(finish);
    vi.spyOn(app, "close").mockImplementation(finish);
    try {
      await app.evaluate(({ dialog }) => {
        // 系统选择器必须由具体旅程提供结果；遗漏模拟时报告错误，不能弹出真实窗口。
        const unexpected = (name: string): never => { throw new Error(`后台测试必须模拟${name}，禁止打开系统弹窗`); };
        dialog.showOpenDialog = async () => unexpected("文件选择");
        dialog.showSaveDialog = async () => unexpected("文件保存");
        dialog.showMessageBox = async () => unexpected("消息确认");
        dialog.showErrorBox = () => unexpected("错误提示");
      });
      // 进程存在不代表应用启动成功；先交付主窗口就绪，再由具体旅程等待页面内容。
      await app.firstWindow({ timeout });
      return app;
    } catch (error) {
      try { await finish(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "桌面测试启动与进程回收均失败"); }
      throw error;
    }
  });
});

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.map((finish) => finish()));
  cleanup = [];
  vi.restoreAllMocks();
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "桌面测试未能正常回收进程");
});
