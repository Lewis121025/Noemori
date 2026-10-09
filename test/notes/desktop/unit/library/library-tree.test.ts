import { describe, expect, it } from "vitest";
import { buildWorkspaceTree, workspaceTreeRows } from "@reader/renderer/library/workspace-tree";
import type { VaultEntry } from "@reader/shared/api";
function libraryTreeRows(entries: VaultEntry[], expanded: ReadonlySet<string>, matches?: ReadonlySet<string>, closed = new Set<string>()) {
 return workspaceTreeRows(buildWorkspaceTree(entries, [], "/notes", false), expanded, matches ? "search" : "", matches ?? new Set(), closed);
}

const entries: VaultEntry[] = [
  { path: "研究", kind: "directory" },
  { path: "研究/光学", kind: "directory" },
  { path: "研究/光学/折射.md", kind: "file", modifiedAt: 2000 },
  { path: "研究/光学/波前.md", kind: "file", modifiedAt: 3000 },
  { path: "归档/折射.md", kind: "file", modifiedAt: 1000 },
  { path: "空目录", kind: "directory" },
];
const paths = (rows: ReturnType<typeof libraryTreeRows>) => rows.map((row) => row.key);

describe("层级搜索的可见顺序", () => {
  it("正文命中保留祖先，同名文件按完整路径区分", () => {
    const rows = libraryTreeRows(
      entries,
      new Set(),
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
              new Set(["研究/光学/折射.md", "归档/折射.md"]),
          new Set(["研究"]),
        ),
      ),
    ).toEqual(["归档", "归档/折射.md", "研究"]);
    expect([...expanded]).toEqual(["研究", "研究/光学"]);
    expect(paths(libraryTreeRows(entries, expanded))).toContain("空目录");
  });
  it("文件始终按名称自然排列，文件夹保持稳定顺序", () => {
    const expanded = new Set(["研究", "研究/光学", "归档"]);
    const rows = libraryTreeRows(entries, expanded);
    expect(paths(rows).filter((path) => path.startsWith("研究/光学/"))).toEqual([
      "研究/光学/波前.md",
      "研究/光学/折射.md",
    ]);
    expect(paths(rows).filter((path) => !path.includes("/"))).toEqual(["归档", "空目录", "研究"]);
  });
});
