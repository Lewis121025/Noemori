import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../modules/notes/packages/desktop/", import.meta.url)),
  test: {
    setupFiles: ["../../../../test/notes/desktop/support/window-mode.ts", "../../../../test/notes/desktop/support/electron-lifecycle.ts"],
    include: ["../../../../test/agent/desktop/e2e/*.test.mts", "../../../../test/agent/browser/e2e/*.test.mts"],
    environment: "node", fileParallelism: false, testTimeout: 45000,
  },
});
