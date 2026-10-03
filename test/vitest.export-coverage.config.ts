import { defineConfig } from "vitest/config";
import unit from "./vitest.config";

// 所有新增导出模块均计入分母，未命中的页面和故障分支不能被配置排除。
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    include: [
      "../../../../test/notes/desktop/unit/export/*.test.ts",
      "../../../../test/notes/desktop/integration/export/*.test.ts",
      "../../../../test/notes/desktop/unit/contracts/export.test.ts",
    ],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "src/features/reader/main/export/**/*.ts",
        "src/features/reader/renderer/export/**/*.{ts,svelte}",
        "src/features/reader/shared/export*.ts",
      ],
      reportsDirectory: "../../.artifacts/export-coverage",
      reporter: ["text", "json", "html"],
      reportOnFailure: true,
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
