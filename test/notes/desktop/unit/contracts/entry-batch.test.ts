import { describe, expect, it } from "vitest";
import {
  independentEntryPaths,
  parseEntryBatchRequest,
  parseEntryBatchResult,
  planEntryBatch,
  type EntryBatchRequest,
} from "@reader/shared/entry-batch";
import type { VaultEntry } from "@reader/shared/api";

const entries: VaultEntry[] = [
  { path: "a.md", kind: "file" },
  { path: "b.md", kind: "file" },
  { path: "folder", kind: "directory" },
  { path: "folder/a.md", kind: "file" },
  { path: "target", kind: "directory" },
];
const request: EntryBatchRequest = {
  root: "/vault",
  action: "move",
  paths: ["a.md", "b.md"],
  destination: "target",
};

describe("批量操作协议", () => {
  it("父文件夹覆盖全部选中后代，前缀相似的兄弟仍是独立条目", () => {
    expect(independentEntryPaths(["folder/a.md", "folder", "folder-other", "folder"])).toEqual([
      "folder",
      "folder-other",
    ]);
    expect(parseEntryBatchRequest({ ...request, paths: ["folder/a.md", "folder"] }).paths).toEqual([
      "folder",
    ]);
    for (const invalid of [[], ["../a.md"], ["a.md", 5], ["/root"]])
      expect(() => parseEntryBatchRequest({ ...request, paths: invalid })).toThrow();
  });
  it("完整预检冲突与跳过当前目录", () => {
    expect(planEntryBatch([...entries, { path: "target/b.md", kind: "file" }], request).issues[0]?.path).toBe("b.md");
    expect(planEntryBatch(entries, { ...request, paths: ["folder"], destination: "folder" }).issues).toHaveLength(1);
    expect(planEntryBatch(entries, { ...request, paths: ["missing"] }).issues).toHaveLength(1);
    expect(planEntryBatch(entries, { ...request, paths: ["a.md", "folder/a.md"] }).issues).toHaveLength(1);
    expect(planEntryBatch(entries, { ...request, destination: "" }).skipped).toEqual(["a.md", "b.md"]);
  });
  it("部分结果不能把已提交项再次放入待重试列表", () => {
    const result = { completed: [{ from: "a.md", to: "target/a.md" }], remaining: ["b.md"], skipped: [], issues: [], warning: "索引待刷新" };
    expect(parseEntryBatchResult(result)).toEqual(result);
    expect(() => parseEntryBatchResult({ ...result, remaining: ["a.md"] })).toThrow();
  });
});
