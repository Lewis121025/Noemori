import { describe, expect, it } from "vitest";
import {
  emptySession,
  parseSession,
} from "../../../../../modules/notes/packages/desktop/src/main/session";
import { emptyReaderSession } from "@reader/shared/session";

describe("应用与阅读器会话", () => {
  it("迁移旧版平铺字段，保留主题、窗口、笔记库与文件栏，忽略旧分栏配置", () => {
    const window = { x: 10, y: 20, width: 800, height: 600, maximized: false };
    expect(
      parseSession(
        JSON.stringify({
          appearance: "dark",
          window,
          vaultRoot: "/notes",
          currentPath: "a.md",
          leftWidth: 230,
          filesCollapsed: true,
          rightSplit: true,
          rightSlots: [{ viewId: "backlinks", pinnedPath: "a.md" }],
        }),
      ),
    ).toEqual({
      appearance: "dark",
      readingFont: "lora",
      window,
      reader: {
        vaultRoot: "/notes",
        documents: {
          panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }],
          active: 0,
          split: false,
        },
        leftWidth: 230,
        filesCollapsed: true,
        viewModes: {},
        recentFiles: [],
        fileTree: null,
      },
    });
  });
  it("新命名空间优先，旧平铺字段不能覆盖阅读器状态", () => {
    const session = {
      ...emptySession,
      appearance: "light" as const,
      reader: {
        ...emptyReaderSession,
        vaultRoot: "/new",
        documents: {
          panes: [{ currentPath: "new.md", history: { back: [], forward: [] } }],
          active: 0,
          split: false,
        },
      },
    };
    expect(
      parseSession(JSON.stringify({ ...session, vaultRoot: "/old", currentPath: "old.md" })),
    ).toEqual(session);
  });
  it("缺失或非法外观与阅读器状态回退默认值", () => {
    for (const appearance of [undefined, null, "sepia", {}, 1]) {
      expect(parseSession(JSON.stringify({ appearance }))?.appearance).toBe("system");
    }
    expect(parseSession(JSON.stringify({ reader: null }))).toEqual(emptySession);
  });
  it("拒绝无效 JSON 和非对象根值", () => {
    for (const value of ["{", "[]", "null"]) expect(parseSession(value)).toBeNull();
  });
  it("阅读字体跨库保存，缺失或非法偏好回退 Lora", () => {
    for (const font of ["lora", "newsreader", "sans"]) {
      expect(parseSession(JSON.stringify({ readingFont: font }))?.readingFont).toBe(font);
    }
    for (const font of [undefined, null, "unknown", "__proto__", {}, []]) {
      expect(parseSession(JSON.stringify({ readingFont: font }))?.readingFont).toBe("lora");
    }
  });
});
