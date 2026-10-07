import { describe, expect, it } from "vitest";
import { libraryTreeRows } from "@reader/renderer/library/library-tree";
import type { VaultEntry } from "@reader/shared/api";

const entries: VaultEntry[] = [
  { path: "研究", kind: "directory" },
  { path: "研究/光学", kind: "directory" },
  { path: "研究/光学/折射.md", kind: "file", modifiedAt: 2000 },
  { path: "研究/光学/波前.md", kind: "file", modifiedAt: 3000 },
  { path: "归档/折射.md", kind: "file", modifiedAt: 1000 },
  { path: "空目录", kind: "directory" },
];
const paths = (rows: ReturnType<typeof libraryTreeRows>) => rows.map((row) => row.node.path);

describe("层级搜索的可见顺序", () => {
  it("正文命中保留祖先，同名文件按完整路径区分", () => {
    const rows = libraryTreeRows(
      entries,
      new Set(),
      "name",
      new Set(["研究/光学/波前.md", "归档/折射.md"]),
    );
    expect(paths(rows)).toEqual(["归档", "归档/折射.md", "研究", "研究/光学", "研究/光学/波前.md"]);
    expect(rows.at(-1)).toMatchObject({ depth: 2, parent: "研究/光学" });
  });
  it("搜索折叠仅隐藏该分支，不修改浏览目录的展开状态", () => {
    const expanded = new Set(["研究", "研究/光学"]);
    expect(
      paths(
        libraryTreeRows(
          entries,
          expanded,
          "name",
          new Set(["研究/光学/折射.md", "归档/折射.md"]),
          new Set(["研究"]),
        ),
      ),
    ).toEqual(["归档", "归档/折射.md", "研究"]);
    expect([...expanded]).toEqual(["研究", "研究/光学"]);
    expect(paths(libraryTreeRows(entries, expanded, "name"))).toContain("空目录");
  });
  it("时间排序仅改变同级文件，文件夹保持稳定顺序", () => {
    const expanded = new Set(["研究", "研究/光学", "归档"]);
    const rows = libraryTreeRows(entries, expanded, "modified");
    expect(paths(rows).filter((path) => path.startsWith("研究/光学/"))).toEqual([
      "研究/光学/波前.md",
      "研究/光学/折射.md",
    ]);
    expect(paths(rows).filter((path) => !path.includes("/"))).toEqual(["归档", "空目录", "研究"]);
  });
});
