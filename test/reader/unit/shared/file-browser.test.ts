import { describe, expect, it } from "vitest";
import {
  emptyFileTreeState,
  mapFileTreeState,
  parseFileTreeMessage,
  parseFileTreeState,
  reconcileFileTreeState,
} from "@reader/shared/file-browser";

describe("目录会话边界", () => {
  it("资料管理的查询和浏览分类随现场保存，改名不清空当前查询", () => {
    const state = {
      ...emptyFileTreeState(),
      browse: { query: "设计", section: "files" as const },
    };
    expect(parseFileTreeMessage(state)).toEqual(state);
    expect(mapFileTreeState(state, (path) => path)).toEqual(state);
    expect(reconcileFileTreeState(state, [])).toEqual(state);
    expect(() =>
      parseFileTreeMessage({ ...state, browse: { query: 1, section: "files" } }),
    ).toThrow();
  });
  it("Unix 文件名里的反斜杠沿目录会话原样往返，不阻止关窗保存", () => {
    const state = {
      expanded: ["资料\\原稿"],
      selected: ["资料\\原稿/笔记.md"],
      focused: "资料\\原稿/笔记.md",
      scroll: { path: "资料\\原稿/笔记.md", offset: 12 },
    };
    expect(parseFileTreeState(state)).toEqual(state);
    expect(parseFileTreeMessage(state)).toEqual(state);
  });

  it("一万文件加父目录的全选跨保存边界不会截断", () => {
    const selected = Array.from({ length: 10100 }, (_, index) => `item-${index}`);
    const state = { ...emptyFileTreeState(), selected };
    expect(parseFileTreeMessage(state).selected).toEqual(selected);
  });
  it("旧会话为空，损坏路径逐项丢弃，IPC 缺字段则拒绝", () => {
    expect(parseFileTreeState(undefined)).toBeNull();
    expect(
      parseFileTreeState({
        expanded: ["folder", "../bad", "folder"],
        selected: ["/abs", "a.md"],
        focused: "x/../bad",
        scroll: { path: "a.md", offset: Infinity },
      }),
    ).toEqual({ expanded: ["folder"], selected: ["a.md"], focused: null, scroll: null });
    expect(() => parseFileTreeMessage({})).toThrow();
    expect(parseFileTreeMessage(emptyFileTreeState())).toEqual(emptyFileTreeState());
  });
  it("目录改名迁移选择、展开和滚动锚点，外部删除只移除失效项", () => {
    const state = {
      expanded: ["old", "keep"],
      selected: ["old/a.md", "keep/b.md"],
      focused: "old/a.md",
      scroll: { path: "old/a.md", offset: 12 },
    };
    const moved = mapFileTreeState(state, (path) =>
      path === "old" || path.startsWith("old/") ? `new${path.slice(3)}` : path,
    );
    expect(moved.scroll).toEqual({ path: "new/a.md", offset: 12 });
    expect(moved.expanded).toEqual(["new", "keep"]);
    expect(
      reconcileFileTreeState(moved, [
        { path: "keep/b.md", kind: "file" },
        { path: "other.md", kind: "file" },
      ]),
    ).toEqual({ expanded: ["keep"], selected: ["keep/b.md"], focused: null, scroll: null });
    expect(state.focused).toBe("old/a.md");
  });
});
