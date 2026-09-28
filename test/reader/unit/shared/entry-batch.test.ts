import { describe, expect, it, vi } from "vitest";
import { createSerialEntryBatchRunner, executeEntryBatch } from "@reader/main/entry-batch";
import { EntryBatchControl } from "@reader/main/entry-batch-control";
import {
  independentEntryPaths,
  parseEntryBatchRequest,
  parseEntryBatchResult,
  planEntryBatch,
  type EntryBatchRequest,
  type EntryMutation,
} from "@reader/shared/entry-batch";
import type { RenameOutcome, VaultEntry } from "@reader/shared/api";

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

function executeSerialBatch(
  entries: readonly VaultEntry[],
  request: EntryBatchRequest,
  check: (changes: EntryMutation[]) => void,
  apply: (change: EntryMutation) => RenameOutcome,
  control?: EntryBatchControl,
) {
  return executeEntryBatch(
    entries,
    request,
    createSerialEntryBatchRunner(check, apply),
    () => ({ warning: null }),
    control,
  );
}

describe("批量操作契约", () => {
  it("每次提交立即迁移会话；会话异常累积为警告并继续处理剩余项", () => {
    const observer = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("会话写盘失败");
      })
      .mockReturnValue({ warning: null });
    const control = new EntryBatchControl();
    const result = executeEntryBatch(
      entries,
      request,
      (changes, progress) => {
        expect(progress(0)).toBe(true);
        expect(progress(1)).toBe(true);
        expect(observer).toHaveBeenLastCalledWith(changes[0]);
        expect(control.progress.completed).toBe(1);
        expect(progress(2)).toBe(true);
        expect(observer).toHaveBeenCalledTimes(2);
        return { completed: 2, issue: null, warning: "索引待刷新" };
      },
      observer,
      control,
    );
    expect(result.remaining).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.warning).toContain("会话写盘失败");
    expect(result.warning).toContain("索引待刷新");
    expect(observer).toHaveBeenCalledTimes(2);
  });
  it("最终完成数补齐未送达的进度，已观察的提交不重复迁移会话", () => {
    const observer = vi.fn(() => ({ warning: null }));
    const result = executeEntryBatch(
      entries,
      request,
      (_changes, progress) => {
        progress(0);
        progress(1);
        return { completed: 2, issue: { path: "", message: "进度回调失败" }, warning: null };
      },
      observer,
    );
    expect(result.completed.map((change) => change.from)).toEqual(["a.md", "b.md"]);
    expect(result.remaining).toEqual([]);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(result.issues[0]?.message).toBe("进度回调失败");
  });
  it.each(["异常", "倒退", "越界", "非整数"])(
    "执行器%s保留已确认的提交，拒绝虚假完成数",
    (failure) => {
      const result = executeEntryBatch(
        entries,
        request,
        (_changes, progress) => {
          progress(0);
          progress(1);
          if (failure === "异常") throw new Error("执行器异常");
          return {
            completed: failure === "倒退" ? 0 : failure === "越界" ? 3 : 1.5,
            issue: null,
            warning: null,
          };
        },
        () => ({ warning: null }),
      );
      expect(result.completed).toEqual([{ from: "a.md", to: "target/a.md" }]);
      expect(result.remaining).toEqual(["b.md"]);
      expect(result.issues).toHaveLength(1);
    },
  );
  it("停止信号跨线程共享，只在当前事务完成后停止，剩余项可直接重试", () => {
    const main = new EntryBatchControl();
    const worker = new EntryBatchControl(structuredClone(main.buffer));
    const apply = vi.fn(() => {
      expect(main.progress).toEqual({ phase: "running", completed: 0, total: 2 });
      main.stop();
      return { warning: "索引待刷新" };
    });
    const result = executeSerialBatch(entries, request, vi.fn(), apply, worker);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.completed).toEqual([{ from: "a.md", to: "target/a.md" }]);
    expect(result.remaining).toEqual(["b.md"]);
    expect(result.issues).toEqual([]);
    expect(result.warning).toContain("索引待刷新");
    expect(main.progress).toEqual({ phase: "running", completed: 1, total: 2 });
    const retried = executeSerialBatch(
      entries,
      { ...request, paths: result.remaining },
      vi.fn(),
      () => ({ warning: null }),
      new EntryBatchControl(),
    );
    expect(retried.remaining).toEqual([]);
    expect(retried.completed.map((change) => change.from)).toEqual(["b.md"]);
  });
  it("预检期间停止不执行第一项", () => {
    const control = new EntryBatchControl();
    const apply = vi.fn();
    const result = executeSerialBatch(
      entries,
      request,
      () => {
        expect(control.progress).toEqual({ phase: "checking", completed: 0, total: 2 });
        control.stop();
      },
      apply,
      control,
    );
    expect(result.remaining).toEqual(request.paths);
    expect(apply).not.toHaveBeenCalled();
  });
  it("进度总数排除已经在目标位置的条目", () => {
    const control = new EntryBatchControl();
    const skipped = executeSerialBatch(
      entries,
      { ...request, paths: ["b.md", "folder/a.md"], destination: "folder" },
      vi.fn(),
      () => ({ warning: null }),
      control,
    );
    expect(skipped.skipped).toEqual(["folder/a.md"]);
    expect(control.progress).toEqual({ phase: "running", completed: 1, total: 1 });
  });
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
  it("同名、子目录与缺失条目在任何写入前拒绝整批", () => {
    const check = vi.fn();
    const apply = vi.fn();
    const result = executeSerialBatch(
      [...entries, { path: "target/b.md", kind: "file" }],
      request,
      check,
      apply,
    );
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual(["a.md", "b.md"]);
    expect(result.issues[0]?.path).toBe("b.md");
    expect(check).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(
      planEntryBatch(entries, { ...request, paths: ["folder"], destination: "folder" }).issues,
    ).toHaveLength(1);
    expect(planEntryBatch(entries, { ...request, paths: ["missing"] }).issues).toHaveLength(1);
    expect(
      planEntryBatch(entries, { ...request, paths: ["a.md", "folder/a.md"] }).issues,
    ).toHaveLength(1);
  });
  it("当前目录项跳过；磁盘预检发现外部冲突仍然零写入", () => {
    expect(planEntryBatch(entries, { ...request, destination: "" }).skipped).toEqual([
      "a.md",
      "b.md",
    ]);
    const apply = vi.fn();
    const result = executeSerialBatch(
      entries,
      request,
      () => {
        throw new Error("外部冲突");
      },
      apply,
    );
    expect(result.issues[0]?.message).toBe("外部冲突");
    expect(apply).not.toHaveBeenCalled();
  });
  it("首个失败立即停止，提交后的警告不影响成功归属，重试仅包含剩余项", () => {
    const check = vi.fn();
    const apply = vi
      .fn()
      .mockReturnValueOnce({ warning: "索引待刷新" })
      .mockImplementationOnce(() => {
        throw new Error("目标已被外部程序占用");
      });
    const result = executeSerialBatch(
      [...entries, { path: "c.md", kind: "file" }],
      { ...request, paths: ["a.md", "b.md", "c.md"] },
      check,
      apply,
    );
    expect(result.completed).toEqual([{ from: "a.md", to: "target/a.md" }]);
    expect(result.remaining).toEqual(["b.md", "c.md"]);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(result.warning).toContain("索引待刷新");
    expect(parseEntryBatchResult(result)).toEqual(result);
    expect(() => parseEntryBatchResult({ ...result, remaining: ["a.md"] })).toThrow();
  });
});
