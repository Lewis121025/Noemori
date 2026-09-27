/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileEntryDialog from "@reader/renderer/components/files/FileEntryDialog.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import type { VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const source: VaultEntry = { path: "项目/笔记.md", kind: "file" };
let component: FileEntryDialog;
let target: HTMLDivElement;
let dialog: HTMLDialogElement;
let completed: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof createReaderApiMock>;
let workspace: ReaderWorkspaceController;

beforeEach(async () => {
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      source,
      { path: "项目", kind: "directory" },
      { path: "归档", kind: "directory" },
      { path: "归档/笔记.md", kind: "file" },
      { path: "收件箱", kind: "directory" },
      { path: "资料", kind: "directory" },
    ]),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  completed = vi.fn();
  component = mount(FileEntryDialog, { target, props: { workspace, onComplete: completed } });
  flushSync();
  dialog = target.querySelector("dialog")!;
  // jsdom 不提供原生弹层和布局；真实滚动、焦点与 Enter 默认提交由 Electron 旅程验证。
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  await component.open("move", source, "项目");
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

function query(text: string): void {
  const input = target.querySelector<HTMLInputElement>('[role="combobox"]')!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function submit(): void {
  target
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
}

const confirm = () => target.querySelector<HTMLButtonElement>('button[type="submit"]')!;

describe("移动文件的连续操作", () => {
  it("已选择的目标被外部删除后禁止提交，不自动改到其他文件夹", async () => {
    query("");
    [...target.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.title === "收件箱")!
      .click();
    flushSync();
    expect(confirm().disabled).toBe(false);
    const entries = await api.vaultEntries();
    vi.mocked(api.vaultEntries).mockResolvedValue(
      entries.filter((entry) => entry.path !== "收件箱"),
    );
    await workspace.refreshList();
    flushSync();
    expect(confirm().disabled).toBe(true);
    submit();
    expect(api.entryRename).not.toHaveBeenCalled();
  });

  it("打开时聚焦目标搜索，当前位置和同名冲突不可提交", () => {
    expect(document.activeElement).toBe(target.querySelector('[role="combobox"]'));
    expect(confirm().disabled).toBe(true);
    query("归档");
    expect(target.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(target.textContent).toContain("已有同名条目");
    submit();
    expect(api.entryRename).not.toHaveBeenCalled();
  });

  it("过滤后可直接提交，移动请求保留完整路径和扩展名", async () => {
    vi.mocked(api.entryRename).mockImplementationOnce(async (_from, to) => {
      const entries = await api.vaultEntries();
      vi.mocked(api.vaultEntries).mockResolvedValue(
        entries.map((entry) => (entry.path === source.path ? { ...entry, path: to } : entry)),
      );
      return { warning: null };
    });
    query("收件");
    expect(confirm().disabled).toBe(false);
    expect(target.textContent).toContain("移动后：收件箱/笔记.md");
    submit();
    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith({
        action: "relocate",
        from: source.path,
        entry: { ...source, path: "收件箱/笔记.md" },
      }),
    );
    expect(api.entryRename).toHaveBeenCalledExactlyOnceWith(source.path, "收件箱/笔记.md");
    expect(dialog.open).toBe(false);
  });

  it("无匹配时不会沿用旧目标，重新打开也不残留上一次搜索", async () => {
    query("资料");
    expect(confirm().disabled).toBe(false);
    query("不存在");
    expect(confirm().disabled).toBe(true);
    submit();
    expect(api.entryRename).not.toHaveBeenCalled();
    expect(target.querySelector('[role="status"]')?.textContent).toBe("没有匹配的文件夹");
    dialog.close();
    await component.open("move", source, "项目");
    flushSync();
    expect(target.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe("");
    expect(confirm().disabled).toBe(true);
  });

  it("方向键跳过不可移动的目标，输入法确认不提交，失败可原地重试", async () => {
    const input = target.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    expect(target.textContent).toContain("移动后：笔记.md");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    expect(target.textContent).toContain("移动后：收件箱/笔记.md");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
    submit();
    expect(api.entryRename).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    vi.mocked(api.entryRename).mockRejectedValueOnce(new Error("目标文件夹已移走"));
    submit();
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain("目标文件夹已移走"),
    );
    expect(dialog.open).toBe(true);
    expect(target.textContent).toContain("移动后：收件箱/笔记.md");
    submit();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  });
});
