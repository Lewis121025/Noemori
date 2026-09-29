import { _electron as electron } from "playwright-core";
import { afterEach, beforeEach, vi } from "vitest";
import { closeTestProcess } from "./process-cleanup";

// 所有桌面旅程共用清理边界，测试断言失败也不能绕过；临时目录在 onTestFinished 才删除。
const launch = electron.launch.bind(electron);
let cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanup = [];
  vi.spyOn(electron, "launch").mockImplementation(async (options) => {
    const app = await launch(options);
    const child = app.process();
    const close = app.close.bind(app);
    let closing: Promise<void> | null = null;
    const finish = () => {
      closing ??= closeTestProcess(child, close);
      return closing;
    };
    cleanup.push(finish);
    vi.spyOn(app, "close").mockImplementation(finish);
    return app;
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
