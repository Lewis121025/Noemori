/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let component: LibraryBrowser;
let target: HTMLDivElement;
let workspace: ReaderWorkspaceController;
let api: ReturnType<typeof createReaderApiMock>;
let entries: VaultEntry[];
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};
const row = (path: string) => target.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)!;
const input = () => target.querySelector<HTMLInputElement>(".inline-rename")!;

beforeEach(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  entries = [
    { path: "项目", kind: "directory" },
    { path: "项目/笔记.md", kind: "file" },
    { path: "项目/已有.md", kind: "file" },
  ];
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => entries),
    vaultList: vi.fn(async () =>
      entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    ),
    entryRename: vi.fn(async (from, to) => {
      entries = entries.map((entry) =>
        entry.path === from || entry.path.startsWith(`${from}/`)
          ? { ...entry, path: to + entry.path.slice(from.length) }
          : entry,
      );
      return { warning: null };
    }),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  await workspace.openFile("项目/笔记.md");
  target = document.createElement("div");
  document.body.append(target);
  component = mount(LibraryBrowser, {
    target,
    props: { workspace, readFile: api.fileRead, onEdit: vi.fn(), onOpen: vi.fn() },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function begin(path = "项目/笔记.md"): Promise<void> {
  row(path).focus();
  row(path).dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  await settle();
}
function type(name: string): void {
  input().value = name;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
function key(key: string, options: KeyboardEventInit = {}): void {
  input().dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
  flushSync();
}

describe("文件树原位重命名", () => {
  it("选中文件名主体，成功后目录与当前文档跟随新路径", async () => {
    await begin();
    expect(document.activeElement).toBe(input());
    expect(input().value.slice(input().selectionStart!, input().selectionEnd!)).toBe("笔记");
    type("新笔记.md");
    key("Enter");
    await settle();
    expect(api.entryRename).toHaveBeenCalledExactlyOnceWith("项目/笔记.md", "项目/新笔记.md");
    expect(workspace.document.path).toBe("项目/新笔记.md");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(row("项目/新笔记.md"));
  });

  it("目录名称全部选中，改名后保留展开状态和子文档", async () => {
    row("项目/笔记.md").focus();
    row("项目/笔记.md").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await settle();
    await begin("项目");
    expect(input().selectionEnd).toBe(2);
    type("计划");
    key("Enter");
    await settle();
    expect(row("计划").getAttribute("aria-expanded")).toBe("true");
    expect(workspace.document.path).toBe("计划/笔记.md");
    expect(document.activeElement).toBe(row("计划"));
  });

  it("Escape、移开焦点和未改动的 Enter 不发起写入", async () => {
    await begin();
    type("取消.md");
    key("Escape");
    await settle();
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(row("项目/笔记.md"));
    await begin();
    type("离开.md");
    target.querySelector<HTMLInputElement>('[role="searchbox"]')!.focus();
    flushSync();
    expect(input()).toBeNull();
    await begin();
    key("Enter");
    await settle();
    expect(api.entryRename).not.toHaveBeenCalled();
  });

  it.each(["", "../越界.md", "已有.md"])("非法或冲突名称 %s 保留输入并说明原因", async (name) => {
    await begin();
    type(name);
    key("Enter");
    expect(api.entryRename).not.toHaveBeenCalled();
    expect(input().value).toBe(name);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(target.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  it("输入法确认和取消不触发文件操作；失败保留名称供原地重试", async () => {
    await begin();
    type("新笔记.md");
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    key("Enter");
    key("Escape");
    expect(input()).not.toBeNull();
    expect(api.entryRename).not.toHaveBeenCalled();
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    key("Enter", { keyCode: 229 });
    expect(api.entryRename).not.toHaveBeenCalled();
    input().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    vi.mocked(api.entryRename).mockRejectedValueOnce(new Error("磁盘只读"));
    key("Enter");
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("磁盘只读");
    expect(input().value).toBe("新笔记.md");
    expect(document.activeElement).toBe(input());
    key("Enter");
    await settle();
    expect(workspace.document.path).toBe("项目/新笔记.md");
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });

  it("等待提交时名称只读，重复确认或 Escape 不会启动第二次操作", async () => {
    await begin();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const rename = vi.mocked(api.entryRename).getMockImplementation()!;
    vi.mocked(api.entryRename).mockImplementationOnce(async (from, to) => {
      await completed;
      return rename(from, to);
    });
    type("新笔记.md");
    key("Enter");
    await settle();
    expect(input().readOnly).toBe(true);
    key("Enter");
    key("Escape");
    expect(input()).not.toBeNull();
    expect(api.entryRename).toHaveBeenCalledTimes(1);
    // 保存门禁会禁用搜索框；根目录按钮仍可接收用户焦点。
    const root = target.querySelector<HTMLButtonElement>(".root-label")!;
    root.focus();
    finish();
    await settle();
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(root);
  });

  it("保存门禁失败时不改名，保留输入和未保存编辑，重试先保存再改名", async () => {
    const bytes = new TextEncoder().encode("# 未保存的内容\n");
    vi.spyOn(workspace.navigation, "snapshot").mockReturnValue({ bytes, revision: 1 });
    workspace.document.markDirty();
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("写入失败"));
    await begin();
    type("新笔记.md");
    key("Enter");
    await settle();
    expect(api.entryRename).not.toHaveBeenCalled();
    expect(workspace.document.dirty).toBe(true);
    expect(input().value).toBe("新笔记.md");
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("当前编辑尚未保存");
    key("Enter");
    await settle();
    expect(api.entryRename).toHaveBeenCalledExactlyOnceWith("项目/笔记.md", "项目/新笔记.md");
    expect(vi.mocked(api.fileWrite).mock.calls[1]?.[1]).toEqual(bytes);
    expect(workspace.document.path).toBe("项目/新笔记.md");
  });
});
