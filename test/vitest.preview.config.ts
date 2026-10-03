import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 使用生产构建验证浏览器 API、工作线程与离线资源；Linux 运行时需要显示服务器。
export default defineConfig({
  root: fileURLToPath(new URL("../modules/notes/packages/desktop/", import.meta.url)),
  test: {
    setupFiles: [
      "../../../../test/notes/desktop/support/window-mode.ts",
      "../../../../test/notes/desktop/support/electron-lifecycle.ts",
    ],
    include: [
      "../../../../test/notes/desktop/e2e/export.test.mts",
      "../../../../test/notes/desktop/e2e/vault-opening.test.mts",
      "../../../../test/notes/desktop/e2e/spaces.test.mts",
      "../../../../test/notes/desktop/e2e/attachments.test.mts",
      "../../../../test/notes/desktop/e2e/attachment-import.test.mts",
      "../../../../test/notes/desktop/e2e/workspace.test.mts",
      "../../../../test/notes/desktop/e2e/writing.test.mts",
      "../../../../test/notes/desktop/e2e/composition.test.mts",
      "../../../../test/notes/desktop/e2e/history.test.mts",
      "../../../../test/notes/desktop/e2e/protocol-failure.test.mts",
      "../../../../test/notes/desktop/e2e/table.test.mts",
      "../../../../test/notes/desktop/e2e/continuous-editing.test.mts",
      "../../../../test/notes/desktop/e2e/external-reload.test.mts",
      "../../../../test/notes/desktop/e2e/files.test.mts",
      "../../../../test/notes/desktop/e2e/vault-search.test.mts",
      "../../../../test/notes/desktop/e2e/quick-switcher.test.mts",
      "../../../../test/notes/desktop/e2e/dialect.test.mts",
      "../../../../test/notes/desktop/e2e/hover-preview.test.mts",
      "../../../../test/notes/desktop/e2e/link-completion.test.mts",
      "../../../../test/notes/desktop/e2e/reading-view.test.mts",
      "../../../../test/notes/desktop/e2e/media-embed.test.mts",
      "../../../../test/notes/desktop/e2e/links-navigation.test.mts",
      "../../../../test/notes/desktop/e2e/dead-link-create.test.mts",
      "../../../../test/notes/desktop/e2e/mention-linkify.test.mts",
      "../../../../test/notes/desktop/e2e/embeds.test.mts",
      "../../../../test/notes/desktop/e2e/whiteboard.test.mts",
      "../../../../test/notes/desktop/e2e/properties.test.mts",
      "../../../../test/notes/desktop/e2e/bookmarks.test.mts",
      "../../../../test/notes/desktop/e2e/graph.test.mts",
      "../../../../test/notes/desktop/e2e/source-mode.test.mts",
      "../../../../test/notes/desktop/e2e/blank-layout.test.mts",
      "../../../../test/notes/desktop/e2e/recovery.test.mts",
      "../../../../test/notes/desktop/e2e/source-recovery.test.mts",
      "../../../../test/notes/desktop/e2e/visual-scenes.test.mts",
    ],
    environment: "node",
    // 原生窗口共享系统焦点和菜单，键盘旅程必须串行，避免多个应用争抢组合键。
    fileParallelism: false,
    testTimeout: 45000,
  },
});
