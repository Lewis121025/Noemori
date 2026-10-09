import { expect, it } from "vitest";
import {
  parseDirectoryImportResult,
  parseImportParent,
  parseImportedLibrary,
} from "@reader/shared/directory-import";

it("取消与已完成副本具有不同结果，提交后的警告保留实际位置", () => {
  expect(parseDirectoryImportResult(null)).toBeNull();
  expect(
    parseDirectoryImportResult({ path: "资料/书籍 (2)", files: 5, warning: "索引待重建" }),
  ).toEqual({ path: "资料/书籍 (2)", files: 5, warning: "索引待重建" });
  expect(() => parseDirectoryImportResult({ path: "资料", files: -1, warning: null })).toThrow();
  expect(() => parseDirectoryImportResult({ path: "../资料", files: 1, warning: null })).toThrow();
  expect(() => parseDirectoryImportResult(undefined)).toThrow();
});

it("父目录和文章历史归属使用规范路径，不接受越界或缺失的归属", () => {
  expect(parseImportParent("")).toBe("");
  expect(parseImportParent("资料/书籍")).toBe("资料/书籍");
  expect(() => parseImportParent("../资料")).toThrow();
  expect(parseImportedLibrary({ source: "/原目录", path: "资料" })).toEqual({
    source: "/原目录",
    path: "资料",
  });
  expect(() => parseImportedLibrary({ source: "/原目录", path: "/资料" })).toThrow();
  expect(() => parseImportedLibrary({ path: "资料" })).toThrow();
});
