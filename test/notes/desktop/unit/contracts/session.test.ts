import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEFT_WIDTH,
  RECENT_FILES_LIMIT,
  emptyReaderSession,
  mapPathList,
  mapViewModes,
  parsePaneLayout,
  parseReaderSession,
  pushRecentFile,
} from "@reader/shared/session";

describe("阅读器会话边界", () => {
  it("恢复独立的资料管理空间，旧会话和损坏值保留默认读写入口", () => {
    expect(parsePaneLayout({ space: "library" })?.space).toBe("library");
    expect(parsePaneLayout({ space: "writing" })?.space).toBe("writing");
    expect(parsePaneLayout({ space: "connections" })?.space).toBe("connections");
    expect(parseReaderSession({ space: "connections" }).space).toBe("connections");
    expect(parsePaneLayout({ space: "unknown" })?.space).toBeUndefined();
    expect(parseReaderSession({ space: "library" }).space).toBe("library");
  });
  it("宽度限制在安全范围，缺失和非法值使用默认值", () => {
    expect(parsePaneLayout({ leftWidth: 12 })?.leftWidth).toBe(192);
    expect(parsePaneLayout({ leftWidth: 999 })?.leftWidth).toBe(480);
    expect(parsePaneLayout({ leftWidth: Infinity })?.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
    expect(parsePaneLayout({})?.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
  });
  it("布局更新不能注入应用设置或笔记库路径", () => {
    expect(
      parsePaneLayout({
        vaultRoot: "/evil",
        currentPath: "stolen.md",
        appearance: "dark",
        window: {},
        filesCollapsed: true,
        leftWidth: 200,
        rightSplit: true,
      }),
    ).toEqual({ filesCollapsed: true, leftWidth: 200 });
    expect(parsePaneLayout(null)).toBeNull();
    expect(parsePaneLayout([])).toBeNull();
  });
  it("旧目录状态不影响文件栏，状态解析只返回阅读器字段", () => {
    expect(parseReaderSession({ outlineCollapsed: false, appearance: "dark", window: {} })).toEqual(
      emptyReaderSession,
    );
    expect(parseReaderSession(null)).toEqual(emptyReaderSession);
    expect(parseReaderSession({ currentPath: "", vaultRoot: 1 })).toEqual(emptyReaderSession);
  });
  it("阅读栈逐条归一化，损坏条目丢弃且不阻止会话恢复", () => {
    const parsed = parseReaderSession({
      history: {
        back: [{ path: "a.md", anchor: "小节" }, { path: "" }, "junk", { path: "b.md", anchor: 5 }],
        forward: [{ path: "c.md" }],
      },
    });
    expect(parsed.documents.panes[0]?.history).toEqual({
      back: [
        { path: "a.md", anchor: "小节" },
        { path: "b.md", anchor: null },
      ],
      forward: [{ path: "c.md", anchor: null }],
    });
    expect(parseReaderSession({}).documents.panes[0]?.history).toEqual({ back: [], forward: [] });
    // 超长历史被截到上限，会话文件不随导航无限增长。
    const long = Array.from({ length: 150 }, (_, index) => ({
      path: `f${index}.md`,
      anchor: null,
    }));
    expect(
      parseReaderSession({ history: { back: long, forward: [] } }).documents.panes[0]?.history.back,
    ).toHaveLength(100);
  });
  it("视图记忆只留已知视图并截到上限，旧版源码视图列表迁移过来", () => {
    expect(
      parseReaderSession({ viewModes: { "a.md": "reading", "b.md": "x", "": "source" } }).viewModes,
    ).toEqual({ "a.md": "reading" });
    const many = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`f${index}.md`, "source"]),
    );
    expect(Object.keys(parseReaderSession({ viewModes: many }).viewModes)).toHaveLength(500);
    expect(parseReaderSession({}).viewModes).toEqual({});
    // 旧版 sourceViews：去重、丢弃非文本，全部迁移为源码视图；新字段在场时忽略旧字段。
    expect(parseReaderSession({ sourceViews: ["a.md", 5, "", "a.md"] }).viewModes).toEqual({
      "a.md": "source",
    });
    expect(
      parseReaderSession({ sourceViews: ["a.md"], viewModes: { "b.md": "reading" } }).viewModes,
    ).toEqual({ "b.md": "reading" });
  });

  it("视图记忆跟随改名与删除迁移，无变化返回 null", () => {
    const modes = { "old/a.md": "source", "keep.md": "reading" } as const;
    expect(
      mapViewModes(modes, (path) => (path.startsWith("old/") ? `new/${path.slice(4)}` : path)),
    ).toEqual({ "new/a.md": "source", "keep.md": "reading" });
    expect(mapViewModes(modes, (path) => (path === "keep.md" ? null : path))).toEqual({
      "old/a.md": "source",
    });
    expect(mapViewModes(modes, (path) => path)).toBeNull();
  });
  it("最近打开列表保序去重、截到上限，置顶与路径迁移不改原列表", () => {
    expect(parseReaderSession({ recentFiles: ["b.md", 1, "a.md", "b.md"] }).recentFiles).toEqual([
      "b.md",
      "a.md",
    ]);
    const many = Array.from({ length: 80 }, (_, index) => `f${index}.md`);
    expect(parseReaderSession({ recentFiles: many }).recentFiles).toHaveLength(RECENT_FILES_LIMIT);
    const recent = ["a.md", "b.md"];
    expect(pushRecentFile(recent, "b.md")).toEqual(["b.md", "a.md"]);
    expect(pushRecentFile(many, "new.md")).toHaveLength(RECENT_FILES_LIMIT);
    expect(recent).toEqual(["a.md", "b.md"]);
    expect(mapPathList(recent, (path) => (path === "a.md" ? null : path))).toEqual(["b.md"]);
    expect(mapPathList(recent, (path) => path)).toBeNull();
  });
});
