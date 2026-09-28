import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 使用生产前端与实际内核线程，独立执行预算验收，避免多个桌面实例争用渲染资源。
export default defineConfig({
  root: fileURLToPath(new URL("../modules/notes/packages/desktop/", import.meta.url)),
  test: {
    setupFiles: ["../../../../test/notes/desktop/support/window-mode.ts"],
    environment: "node",
    env: {
      NOUS_PERFORMANCE_REPORT:
        process.env["NOUS_PERFORMANCE_REPORT"] ??
        fileURLToPath(
          new URL("../modules/notes/.artifacts/reports/performance/latest/", import.meta.url),
        ),
    },
    fileParallelism: false,
    include: ["../../../../test/notes/desktop/performance/*.test.mts"],
    testTimeout: 30000,
  },
});
