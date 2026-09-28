import { describe, expect, it } from "vitest";
import { deadLinkCreatePath, deadLinkSeed } from "@reader/renderer/engine/navigation/dead-link";

describe("deadLinkCreatePath", () => {
  it("裸名落在当前笔记目录并补上 md", () => {
    expect(deadLinkCreatePath("notes/ref.md", "missing", "wiki")).toEqual({
      path: "notes/missing.md",
      anchor: null,
    });
    expect(deadLinkCreatePath("ref.md", "missing#小节", "wiki")).toEqual({
      path: "missing.md",
      anchor: "小节",
    });
  });

  it("路径形式按库根解释，已有扩展名不再追加", () => {
    expect(deadLinkCreatePath("ref.md", "dir/foo", "wiki")).toEqual({
      path: "dir/foo.md",
      anchor: null,
    });
    expect(deadLinkCreatePath("ref.md", "shot.png", "wiki")).toEqual({
      path: "shot.png",
      anchor: null,
    });
  });

  it("Markdown 相对路径解码并拒绝越界和纯锚点", () => {
    expect(deadLinkCreatePath("a/ref.md", "./my%20note.md#sec", "md")).toEqual({
      path: "a/my note.md",
      anchor: "sec",
    });
    expect(deadLinkCreatePath("ref.md", "../secret.md", "md")).toBeNull();
    expect(deadLinkCreatePath("ref.md", "#小节", "wiki")).toBeNull();
    expect(deadLinkCreatePath("ref.md", ".hidden", "wiki")).toBeNull();
  });
});

describe("deadLinkSeed", () => {
  const decode = (bytes: Uint8Array | null) =>
    bytes === null ? null : new TextDecoder().decode(bytes);

  it("# 标题锚点写成首个标题，创建后锚点即可解析", () => {
    expect(decode(deadLinkSeed({ path: "notes/new.md", anchor: "计划 小节" }))).toBe(
      "# 计划 小节\n\n",
    );
  });

  it("块引用、非 Markdown 目标与无锚点不种内容", () => {
    expect(deadLinkSeed({ path: "new.md", anchor: "^block" })).toBeNull();
    expect(deadLinkSeed({ path: "shot.png", anchor: "sec" })).toBeNull();
    expect(deadLinkSeed({ path: "new.md", anchor: null })).toBeNull();
  });

  it("扩展名大小写不敏感", () => {
    expect(decode(deadLinkSeed({ path: "NEW.MD", anchor: "sec" }))).toBe("# sec\n\n");
  });
});
