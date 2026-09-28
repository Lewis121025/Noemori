/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultOpenProgress } from "@reader/shared/vault-opening";
import type { VaultOpenSnapshot } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

it("取消切库后保留原库与文档，迟到进度不能重新显示", async () => {
  let report: ((progress: VaultOpenProgress) => void) | undefined;
  let finish!: (root: VaultOpenSnapshot | null) => void;
  const pending = new Promise<VaultOpenSnapshot | null>((resolve) => {
    finish = resolve;
  });
  const api = createReaderApiMock({
    vaultOpen: vi.fn((progress) => {
      report = progress;
      return pending;
    }),
  });
  const workspace = new ReaderWorkspaceController(api);
  const dispose = workspace.start();
  try {
    await workspace.restore();
    const previous = workspace.document;
    const opening = workspace.openVault();
    await vi.waitFor(() => expect(api.vaultOpen).toHaveBeenCalledOnce());
    report?.({ phase: "reading", completed: 100, total: 1000 });
    expect(workspace.openingProgress?.completed).toBe(100);
    await workspace.cancelOpening();
    expect(api.vaultOpenCancel).toHaveBeenCalledOnce();
    finish(null);
    await opening;
    expect(workspace.vaultRoot).toBe("/notes");
    expect(workspace.document).toBe(previous);
    report?.({ phase: "committing", completed: 0, total: null });
    expect(workspace.openingProgress).toBeNull();
    expect(workspace.switching).toBe(false);
  } finally {
    dispose();
  }
});

it("失败保留原库并显示文件原因，修正后的下一次打开可以成功", async () => {
  const api = createReaderApiMock({
    vaultOpen: vi
      .fn()
      .mockRejectedValueOnce(new Error("无法读取 /new/坏文件.md：权限不足"))
      .mockResolvedValueOnce({ root: "/new", entries: [] }),
  });
  const workspace = new ReaderWorkspaceController(api);
  const dispose = workspace.start();
  try {
    await workspace.restore();
    await workspace.openVault();
    expect(workspace.vaultRoot).toBe("/notes");
    expect(workspace.message).toContain("坏文件.md");
    expect(workspace.openingProgress).toBeNull();
    await workspace.openVault();
    expect(workspace.vaultRoot).toBe("/new");
    expect(workspace.message).toBe("");
  } finally {
    dispose();
  }
});

it("直接发布准备好的目录，提交后不再依赖可能失败的目录读取或重复会话写入", async () => {
  const api = createReaderApiMock();
  const workspace = new ReaderWorkspaceController(api);
  const dispose = workspace.start();
  try {
    await workspace.restore();
    const previous = workspace.document;
    previous.load("original.md", { disk: new TextEncoder().encode("原文"), draft: null });
    vi.mocked(api.vaultEntries).mockClear().mockRejectedValue(new Error("目录响应失败"));
    vi.mocked(api.sessionSetDocuments)
      .mockClear()
      .mockRejectedValue(new Error("不应重复写入已提交的空会话"));
    vi.mocked(api.vaultOpen).mockResolvedValue({
      root: "/new",
      entries: [{ path: "new.md", kind: "file" }],
    });
    await workspace.openVault();
    expect(workspace.vaultRoot).toBe("/new");
    expect(workspace.files).toEqual(["new.md"]);
    expect(workspace.message).toBe("");
    expect(api.vaultEntries).not.toHaveBeenCalled();
    expect(api.sessionSetDocuments).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
