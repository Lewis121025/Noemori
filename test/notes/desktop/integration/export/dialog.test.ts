/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi, type TestContext } from "vitest";
import ExportDialog from "@reader/renderer/export/ExportDialog.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultEntry } from "@reader/shared/api";
import type { ExportResult } from "@reader/shared/export";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

async function setup(t: TestContext, files = ["a.md"]) {
  const originalModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  t.onTestFinished(() => {
    if (originalModal)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  });
  const api = createReaderApiMock({
    vaultEntries: async () => files.map((path): VaultEntry => ({ path, kind: "file" })),
  });
  const workspace = new ReaderWorkspaceController(api);
  const dispose = workspace.start();
  await workspace.restore();
  workspace.requestExport({ kind: "vault" });
  const target = document.createElement("div");
  document.body.append(target);
  const view = mount(ExportDialog, { target, props: { workspace } });
  flushSync();
  let mounted = true;
  const remove = async () => {
    if (mounted) {
      mounted = false;
      await unmount(view);
    }
  };
  t.onTestFinished(async () => {
    await remove();
    dispose();
    target.remove();
    vi.restoreAllMocks();
  });
  const button = (name: string) => {
    const found = Array.from(target.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === name,
    );
    if (!found) throw new Error(`缺少按钮：${name}`);
    return found;
  };
  const submit = () => {
    target
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
  };
  return { workspace, target, button, submit, remove };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("EXP-UI 导出结果、进度与取消交互", () => {
  it.for([
    { files: ["a.md"], formats: ["pdf", "docx", "markdown", "archive"], initial: "pdf" },
    { files: ["a.noemoriboard"], formats: ["png", "svg", "archive"], initial: "svg" },
    { files: [], formats: ["archive"], initial: "archive" },
  ])("格式只提供当前内容的实际能力：%j", async ({ files, formats, initial }, t) => {
    const { target, button, workspace } = await setup(t, files);
    expect(Array.from(target.querySelectorAll("option")).map((node) => node.value)).toEqual(
      formats,
    );
    expect(target.querySelector("select")?.value).toBe(initial);
    button("关闭").click();
    expect(workspace.exportScope).toBeNull();
  });

  it("状态、清单、实际产物与生成后警告均展示，重复提交不启动第二次任务", async (t) => {
    const { workspace, target, submit, button } = await setup(t);
    const done = deferred<ExportResult>();
    const run = vi.spyOn(workspace, "runExport").mockImplementation((_format, progress, plan) => {
      progress({ phase: "snapshotting", completed: 0, total: null, path: "a.md" });
      plan({ files: ["a.md", "image.png"], bytes: 1024 ** 2, issues: [] });
      return done.promise;
    });
    const reveal = vi.spyOn(workspace, "revealExport").mockResolvedValue();
    submit();
    submit();
    expect(run).toHaveBeenCalledOnce();
    expect(target.textContent).toContain("冻结文件内容…");
    expect(target.textContent).toContain("2 个文件");
    expect(target.querySelector("select")?.disabled).toBe(true);
    done.resolve({
      status: "saved",
      path: "/output/actual.zip",
      warning: "已经生成，通知失败",
      issues: [{ path: "a.md", line: 3, severity: "warning", message: "普通链接未导出" }],
    });
    await vi.waitFor(() => expect(target.textContent).toContain("导出完成"));
    expect(target.textContent).toContain("/output/actual.zip");
    expect(target.textContent).toContain("a.md:3：普通链接未导出");
    expect(target.textContent).toContain("已经生成，通知失败");
    button("在文件夹中显示").click();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it.for([true, false, "error"] as const)(
    "取消结果与提交竞争不被伪装为已取消：%s",
    async (outcome, t) => {
      const { workspace, target, submit, button } = await setup(t);
      const done = deferred<ExportResult>();
      vi.spyOn(workspace, "runExport").mockImplementation((_format, progress) => {
        progress({ phase: "converting", completed: 1, total: 2, path: null });
        return done.promise;
      });
      const cancel = vi.spyOn(workspace, "cancelExport");
      if (outcome === "error") cancel.mockRejectedValue(new Error("断开连接"));
      else cancel.mockResolvedValue(outcome);
      submit();
      target.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
      await vi.waitFor(() =>
        expect(target.textContent).toContain(
          outcome === "error" ? "无法确认取消结果" : outcome ? "正在停止导出" : "正在完成提交",
        ),
      );
      expect(button("取消导出").disabled).toBe(outcome !== "error");
      expect(target.textContent).not.toContain("已取消导出");
      done.resolve({ status: "cancelled" });
      await vi.waitFor(() => expect(target.textContent).toContain("已取消导出"));
      expect(button("重新导出").disabled).toBe(false);
    },
  );

  it("失败可修改格式重试，销毁正在执行的弹层会请求取消并报告取消异常", async (t) => {
    const { workspace, target, submit, remove } = await setup(t);
    const done = deferred<ExportResult>();
    const run = vi
      .spyOn(workspace, "runExport")
      .mockResolvedValueOnce({
        status: "failed",
        issues: [{ path: "a.md", severity: "error", message: "源文件变化" }],
      })
      .mockReturnValueOnce(done.promise);
    submit();
    await vi.waitFor(() => expect(target.textContent).toContain("导出未完成"));
    const format = target.querySelector("select");
    if (!format) throw new Error("缺少格式选择");
    format.value = "docx";
    format.dispatchEvent(new Event("change", { bubbles: true }));
    submit();
    expect(run).toHaveBeenLastCalledWith("docx", expect.any(Function), expect.any(Function));
    const cancel = vi.spyOn(workspace, "cancelExport").mockRejectedValue(new Error("取消失败"));
    const report = vi.spyOn(workspace, "report");
    await remove();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(expect.stringContaining("取消失败")),
    );
    done.resolve({ status: "cancelled" });
  });
});
