import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 真实内核测试需要先构建原生模块与工作线程，由根目录 test:core 统一执行。
export default defineConfig({
  root: fileURLToPath(new URL("../modules/notes/packages/desktop/", import.meta.url)),
  test: {
    include: ["../../../../test/reader/integration/native/core-native.test.mts"],
    environment: "node",
    testTimeout: 15000,
  },
});
