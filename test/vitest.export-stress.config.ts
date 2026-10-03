import { defineConfig } from "vitest/config";
import preview from "./vitest.preview.config";

// 压力与持久运行逐项启动生产构建，避免多个 Electron 实例污染内存和响应采样。
export default defineConfig({
  ...preview,
  test: {
    ...preview.test,
    include: [
      "../../../../test/notes/desktop/performance/export.test.mts",
      "../../../../test/notes/desktop/performance/export-cancel.test.mts",
      "../../../../test/notes/desktop/e2e/export-resources.test.mts",
    ],
  },
});
