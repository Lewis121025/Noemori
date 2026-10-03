import { fileURLToPath } from "node:url";

// 沙箱只链接已验收的运行时依赖；被变异的业务代码和测试必须使用独立副本。
process.env.NOEMORI_MUTATION_SOURCE = fileURLToPath(new URL("../", import.meta.url));

/** 导出核心变异门禁：存活变异必须逐项定位，不降低分数或排除未覆盖代码。 */
export default {
  mutate: [
    "modules/notes/packages/desktop/src/features/reader/main/export/**/*.ts",
    "modules/notes/packages/desktop/src/features/reader/renderer/export/**/*.ts",
    "modules/notes/packages/desktop/src/features/reader/shared/export*.ts",
  ],
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "test/tsconfig.export.json",
  vitest: { configFile: "test/vitest.export-coverage.config.ts", related: false },
  buildCommand: "node test/notes/desktop/support/export-mutation.mjs",
  coverageAnalysis: "perTest",
  concurrency: 2,
  timeoutMS: 10_000,
  dryRunTimeoutMinutes: 5,
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["progress", "clear-text", "json", "html", "event-recorder"],
  eventReporter: { baseDir: "modules/notes/.artifacts/export-mutation/events" },
  jsonReporter: { fileName: "modules/notes/.artifacts/export-mutation/report.json" },
  htmlReporter: { fileName: "modules/notes/.artifacts/export-mutation/index.html" },
  incremental: true,
  incrementalFile: "modules/notes/.artifacts/export-mutation/incremental.json",
  tempDirName: "modules/notes/.artifacts/export-mutation/sandbox",
  cleanTempDir: true,
  ignorePatterns: [
    "modules/**/target",
    "modules/**/.artifacts",
    "modules/notes/packages/desktop/out",
    "modules/notes/packages/desktop/.cache",
  ],
};
