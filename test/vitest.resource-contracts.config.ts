import { defineConfig } from "vitest/config";
import unit from "./vitest.config";

// 使用正常测试的编译与别名；本入口只选取确定性的资源契约，不依赖运行机器的速度。
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    include: [
      "../../../../test/notes/desktop/unit/architecture/build-output.test.ts",
      "../../../../test/notes/desktop/unit/shell/session-queue.test.ts",
      "../../../../test/notes/desktop/integration/shell/core-client.test.ts",
      "../../../../test/notes/desktop/unit/preview/media.test.ts",
      "../../../../test/notes/desktop/unit/preview/pdf-render.test.ts",
      "../../../../test/notes/desktop/unit/markdown/nodeview-visibility.test.ts",
      "../../../../test/notes/desktop/integration/shell/process-cleanup.test.ts",
      "../../../../test/notes/desktop/integration/library/file-tree-state.test.ts",
      "../../../../test/notes/desktop/integration/workspace/session-persistence.test.ts",
      "../../../../test/notes/desktop/integration/workspace/workspace-spaces.test.ts",
    ],
  },
});
