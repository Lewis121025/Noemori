import { defineConfig } from "vitest/config";
import preview from "./vitest.preview.config";

// 资源回归独立运行，避免其他桌面实例影响堆、句柄和退出观测。
export default defineConfig({
  ...preview,
  test: {
    ...preview.test,
    include: ["../../../../test/notes/desktop/e2e/resources.test.mts"],
    testTimeout: 120000,
  },
});
