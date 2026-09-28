import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  emptySession,
  loadSession,
  parseSession,
  patchSession,
  serializeSession,
} from "../../../../../modules/notes/packages/desktop/src/main/session";
import { emptyReaderSession } from "@reader/shared/session";

function temporaryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-session-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "session.json");
}

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
  it("应用设置与阅读器状态可以独立持久化，互不覆盖", () => {
    const file = temporaryFile();
    const reader = {
      ...emptyReaderSession,
      vaultRoot: "/notes",
      documents: {
        panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
    };
    patchSession(file, { reader });
    for (const appearance of ["system", "light", "dark"] as const) {
      patchSession(file, { appearance });
      expect(loadSession(file).reader).toEqual(reader);
      patchSession(file, { reader: { ...reader, leftWidth: 240 } });
      expect(loadSession(file).appearance).toBe(appearance);
      patchSession(file, { reader });
    }
  });
  it("会话写回只保留新结构，重启仍能恢复迁移后的状态", () => {
    const file = temporaryFile();
    writeFileSync(
      file,
      JSON.stringify({ vaultRoot: "/notes", currentPath: "a.md", leftWidth: 250 }),
    );
    const migrated = patchSession(file, { appearance: "dark" });
    expect(loadSession(file)).toEqual(migrated);
    expect(JSON.parse(serializeSession(migrated))).not.toHaveProperty("vaultRoot");
    expect(migrated.reader.vaultRoot).toBe("/notes");
  });
  it("文件缺失时使用默认会话", () => {
    expect(loadSession(temporaryFile())).toEqual(emptySession);
  });
});
