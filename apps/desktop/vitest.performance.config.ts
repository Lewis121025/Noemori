import { defineConfig } from "vitest/config";

// 使用生产前端与实际内核线程，独立执行预算验收，避免多个桌面实例争用渲染资源。
export default defineConfig({
  test: {
    setupFiles: ["../../tests/desktop/support/window-mode.ts"],
    environment: "node",
    fileParallelism: false,
    include: ["../../tests/reader/performance/*.test.mts"],
    testTimeout: 30000,
  },
});
