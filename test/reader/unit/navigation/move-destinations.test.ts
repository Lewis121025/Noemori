import { describe, expect, it } from "vitest";
import { moveDestinations } from "@reader/renderer/engine/navigation/move-destinations";
import type { VaultEntry } from "@reader/shared/api";

describe("移动目标契约", () => {
  it("仅列出真实目录，排除自身后代，并区分当前目录与同名冲突", () => {
    const source: VaultEntry = { path: "项目/研究", kind: "directory" };
    expect(
      moveDestinations(
        [
          source,
          { path: "项目", kind: "directory" },
          { path: "项目/研究/资料", kind: "directory" },
          { path: "归档10", kind: "directory" },
          { path: "归档2", kind: "directory" },
          { path: "归档2/研究", kind: "file" },
          { path: "恢复/草稿.md", kind: "file" },
          { path: "不安全", kind: "directory", recoveryOnly: true },
        ],
        source,
      ),
    ).toEqual([
      { path: "", reason: null },
      { path: "归档2", reason: "已有同名条目" },
      { path: "归档10", reason: null },
      { path: "项目", reason: "当前位置" },
    ]);
  });

  it("恢复草稿缺失的父目录仍占用目标名称，相似前缀不被误判为后代", () => {
    expect(
      moveDestinations(
        [
          { path: "笔记.md", kind: "file" },
          { path: "归档", kind: "directory" },
          { path: "归档/笔记.md/草稿.md", kind: "file", recoveryOnly: true },
          { path: "笔记.md-old", kind: "directory" },
        ],
        { path: "笔记.md", kind: "file" },
      ),
    ).toEqual([
      { path: "", reason: "当前位置" },
      { path: "笔记.md-old", reason: null },
      { path: "归档", reason: "已有同名条目" },
    ]);
  });
});
