import { expect, it } from "vitest";
import { parseLibraryEntriesDrag } from "@reader/shared/file-drag";

it("文件拖拽保留库归属和文件种类，复制身份时不携带额外读取权限", () => {
  const source = { root: "/notes", entries: [{ path: "资料/a.md", kind: "file", absolute: "/secret" }, { path: "文件夹", kind: "directory" }] };
  const parsed = parseLibraryEntriesDrag(source);
  expect(parsed).toEqual({ root: "/notes", entries: [{ path: "资料/a.md", kind: "file" }, { path: "文件夹", kind: "directory" }] });
  source.entries[0]!.path = "changed.md";
  expect(parsed.entries[0]!.path).toBe("资料/a.md");
});

it.each([null, {}, { root: "", entries: [] }, { root: "/notes", entries: [] },
  { root: "/notes", entries: [{ path: "../secret", kind: "file" }] },
  { root: "/notes", entries: [{ path: "/secret", kind: "file" }] },
  { root: "/notes", entries: [{ path: "a.md", kind: "unknown" }] },
  { root: "/notes", entries: [{ path: "a.md", kind: "file" }, { path: "a.md", kind: "file" }] },
])("拖拽载荷非法时明确拒绝，不将文件身份退化为引用：%j", (source) => {
  expect(() => parseLibraryEntriesDrag(source)).toThrow();
});
