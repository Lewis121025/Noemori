/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultEntry } from "@reader/shared/api";
import { mapEntryPath, planEntryBatch } from "@reader/shared/entry-batch";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let component: LibraryBrowser;
let target: HTMLDivElement;
let workspace: ReaderWorkspaceController;
let api: ReturnType<typeof createReaderApiMock>;
let entries: VaultEntry[];
let edit: ReturnType<typeof vi.fn>;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};
const row = (path: string) => target.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)!;
const selected = () =>
  [...target.querySelectorAll('[role="gridcell"][aria-selected="true"] [data-path]')].map((node) =>
    node.getAttribute("data-path"),
  );
const click = (path: string, options: MouseEventInit = {}) => {
  row(path).focus();
  row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, ...options }));
  flushSync();
};
const key = (path: string, key: string, options: KeyboardEventInit = {}) => {
  row(path).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
  flushSync();
};
const submit = () =>
  target
    .querySelector(".batch-dialog form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  Element.prototype.scrollIntoView = vi.fn();
  entries = [
    { path: "folder", kind: "directory" },
    { path: "folder/note.md", kind: "file" },
    { path: "target", kind: "directory" },
    ...["a.md", "b.md", "c.md"].map((path): VaultEntry => ({ path, kind: "file" })),
  ];
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => entries),
    entryBatch: vi.fn(async (request) => {
      const plan = planEntryBatch(entries, request);
      const completed = plan.issues.length === 0 ? plan.changes : [];
      entries = entries.flatMap((entry) => {
        const path = mapEntryPath(entry.path, completed);
        return path === null ? [] : [{ ...entry, path }];
      });
      return {
        completed,
        remaining: plan.issues.length === 0 ? [] : request.paths,
        skipped: plan.skipped,
        issues: plan.issues,
        warning: null,
      };
    }),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  edit = vi.fn();
  component = mount(LibraryBrowser, {
    target,
    props: { workspace, readFile: api.fileRead, onEdit: edit, onOpen: vi.fn() },
  });
  flushSync();
  const menu = target.querySelector<HTMLDivElement>(".file-menu")!;
  menu.showPopover = () => {};
  menu.hidePopover = () => {};
});

afterEach(async () => {
  workspace.fileTree.reset();
  await unmount(component);
  target.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("文件树多选与批量整理", () => {
  it("浏览器滚动事件尚未交付时，行焦点更新不回放旧锚点", () => {
    const viewport = target.querySelector<HTMLElement>('[role="treegrid"]')!;
    viewport.scrollTop = 48;
    row("c.md").focus();
    flushSync();
    expect(viewport.scrollTop).toBe(48);
  });

  it("显示提交进度，停止后保留已完成项，继续只处理剩余项", async () => {
    let finish = () => {};
    vi.mocked(api.entryBatch).mockImplementationOnce(async (_request, onProgress) => {
      onProgress?.({ phase: "running", completed: 1, total: 2 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      entries = entries.filter((entry) => entry.path !== "a.md");
      return {
        completed: [{ from: "a.md", to: null }],
        remaining: ["b.md"],
        skipped: [],
        issues: [],
        warning: null,
      };
    });
    click("a.md", { metaKey: true });
    click("b.md", { metaKey: true });
    key("b.md", "Delete");
    submit();
    await settle();
    const dialog = target.querySelector<HTMLDialogElement>(".batch-dialog")!;
    expect(dialog.querySelector("progress")?.value).toBe(1);
    expect(dialog.querySelector("progress")?.max).toBe(2);
    const stop = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "停止",
    )!;
    expect(stop.disabled).toBe(false);
    stop.click();
    await settle();
    expect(api.entryBatchStop).toHaveBeenCalledExactlyOnceWith("/notes");
    expect(dialog.textContent).toContain("等待当前条目完成");
    expect(dialog.open).toBe(true);
    expect(api.entryBatch).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(dialog.textContent).toContain("已停止");
    expect(selected()).toEqual(["b.md"]);
    submit();
    await settle();
    expect(api.entryBatch).toHaveBeenLastCalledWith(
      { root: "/notes", action: "trash", paths: ["b.md"] },
      expect.any(Function),
    );
    expect(dialog.open).toBe(false);
  });
  it("只移动焦点后删除仍作用于高亮选择，没有选择时不隐式删除焦点条目", async () => {
    click("a.md", { metaKey: true });
    key("a.md", "ArrowDown", { ctrlKey: true });
    await settle();
    expect(document.activeElement).toBe(row("b.md"));
    expect(selected()).toEqual(["a.md"]);
    key("b.md", "Delete");
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      "trash",
      expect.objectContaining({ path: "a.md", kind: "file" }),
      "",
    );
    edit.mockClear();
    click("a.md", { metaKey: true });
    key("a.md", "Delete");
    expect(selected()).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  it("重命名与删除共用选择目标，不能改名未选中的焦点条目", async () => {
    click("a.md", { metaKey: true });
    key("a.md", "ArrowDown", { ctrlKey: true });
    await settle();
    key("b.md", "F2");
    await settle();
    const input = target.querySelector<HTMLInputElement>('input[aria-label="重命名文件"]')!;
    expect(input.value).toBe("a.md");
  });

  it("外部删除焦点条目后接续下一项，保留其他选择，末项删除时接续前一项", async () => {
    click("a.md", { metaKey: true });
    click("b.md", { metaKey: true });
    entries = entries.filter((entry) => entry.path !== "b.md");
    await workspace.refreshList();
    await settle();
    expect(document.activeElement).toBe(row("c.md"));
    expect(selected()).toEqual(["a.md"]);
    expect(workspace.fileTree.state.focused).toBe("c.md");
    entries = entries.filter((entry) => entry.path !== "c.md");
    await workspace.refreshList();
    await settle();
    expect(document.activeElement).toBe(row("folder"));
  });

  it("目录清空后焦点回到搜索；编辑其他控件时目录变化不抢焦点", async () => {
    click("a.md", { metaKey: true });
    const search = target.querySelector<HTMLInputElement>('[role="searchbox"]')!;
    search.focus();
    entries = entries.filter((entry) => entry.path !== "a.md");
    await workspace.refreshList();
    await settle();
    expect(document.activeElement).toBe(search);
    row("b.md").focus();
    entries = [];
    await workspace.refreshList();
    await settle();
    expect(document.activeElement).toBe(search);
  });

  it("Cmd/Ctrl 点选、Shift 范围可收缩，右键保留分组，键盘操作不打开笔记", async () => {
    click("a.md", { metaKey: true });
    click("c.md", { shiftKey: true });
    expect(selected()).toEqual(["a.md", "b.md", "c.md"]);
    key("c.md", "ArrowUp", { shiftKey: true });
    await settle();
    expect(selected()).toEqual(["a.md", "b.md"]);
    click("c.md", { ctrlKey: true });
    row("a.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();
    expect(selected()).toEqual(["a.md", "b.md", "c.md"]);
    expect(target.querySelector('[role="menu"]')?.textContent).not.toContain("重命名");
    expect(api.fileSnapshot).not.toHaveBeenCalled();
    key("a.md", "a", { metaKey: true });
    expect(selected()).toHaveLength(5);
    key("a.md", "Escape");
    expect(selected()).toEqual(["a.md"]);
    key("a.md", " ");
    expect(selected()).toEqual([]);
  });

  it("进入文件夹不携带旧目录选择，路径搜索的父子多选只执行父目录", async () => {
    click("folder");
    row("folder").dispatchEvent(new MouseEvent("dblclick", { bubbles:true }));
    await settle();
    expect(selected()).toEqual(["folder"]);
    expect(row("folder/note.md")).not.toBeNull();
    const root = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "全部文件")!;
    root.click();
    const search = target.querySelector<HTMLInputElement>('[role="searchbox"]')!;
    search.value = "folder";
    search.dispatchEvent(new Event("input", { bubbles:true }));
    flushSync();
    click("folder", { metaKey:true });
    click("folder/note.md", { metaKey:true });
    key("folder/note.md", "Delete");
    await settle();
    submit();
    await settle();
    expect(api.entryBatch).toHaveBeenCalledExactlyOnceWith({ root:"/notes", action:"trash", paths:["folder"] }, expect.any(Function));
    expect(entries.some((entry) => entry.path.startsWith("folder"))).toBe(false);
  });

  it("部分成功保留已提交项，重试只发送剩余项，输入法与忙碌状态不会重复提交", async () => {
    click("a.md", { metaKey: true });
    click("b.md", { metaKey: true });
    key("b.md", "Delete");
    await settle();
    const dialog = target.querySelector<HTMLDialogElement>(".batch-dialog")!;
    dialog.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    submit();
    expect(api.entryBatch).not.toHaveBeenCalled();
    dialog.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    dialog.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    let finish!: () => void;
    vi.mocked(api.entryBatch).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      entries = entries.filter((entry) => entry.path !== "a.md");
      return {
        completed: [{ from: "a.md", to: null }],
        remaining: ["b.md"],
        skipped: [],
        issues: [{ path: "b.md", message: "被占用" }],
        warning: null,
      };
    });
    submit();
    await settle();
    submit();
    expect(api.entryBatch).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("已完成 1 项");
    expect(selected()).toEqual(["b.md"]);
    submit();
    await settle();
    expect(api.entryBatch).toHaveBeenLastCalledWith(
      {
        root: "/notes",
        action: "trash",
        paths: ["b.md"],
      },
      expect.any(Function),
    );
    expect(dialog.open).toBe(false);
    expect(workspace.messageNeedsAttention).toBe(false);
    expect(entries.some((entry) => ["a.md", "b.md"].includes(entry.path))).toBe(false);
  });

  it("恢复会话尊重主动折叠，清单前方新增条目后仍锚定原来可见的文件", async () => {
    await unmount(component);
    await workspace.openFile("folder/note.md");
    workspace.fileTree.restore(
      {
        expanded: [],
        selected: ["b.md", "c.md"],
        focused: "b.md",
        scroll: { path: "b.md", offset: 7 },
      },
      entries,
    );
    component = mount(LibraryBrowser, {
      target,
      props: { workspace, readFile: api.fileRead, onEdit: vi.fn(), onOpen: vi.fn() },
    });
    flushSync();
    expect(workspace.fileTree.state.expanded).toEqual([]);
    expect(selected()).toEqual(["b.md", "c.md"]);
    const tree = target.querySelector<HTMLUListElement>('[role="treegrid"]')!;
    const before = tree.scrollTop;
    entries = [...entries, { path: "0.md", kind: "file" }];
    await workspace.refreshList();
    flushSync();
    expect(tree.scrollTop).toBeCloseTo(before + 28);
    expect(workspace.fileTree.state.scroll).toEqual({ path: "b.md", offset: 7 });
    entries = entries.filter((entry) => entry.path !== "c.md");
    await workspace.refreshList();
    flushSync();
    expect(selected()).toEqual(["b.md"]);
  });

  it("桥接中断导致结果未知时保留说明，不能把可能已完成的项直接重试", async () => {
    click("a.md", { metaKey: true });
    click("b.md", { metaKey: true });
    key("b.md", "Delete");
    await settle();
    vi.mocked(api.entryBatch).mockRejectedValueOnce(new Error("内核任务中断"));
    submit();
    await settle();
    expect(target.querySelector('.batch-dialog [role="alert"]')?.textContent).toContain("未能确认");
    submit();
    await settle();
    expect(api.entryBatch).toHaveBeenCalledTimes(1);
  });
});

it("从未选中行开始拖动时，拖拽载荷只包含该行，不沿用上次选择", () => {
  click("b.md");
  const setData = vi.fn();
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData, effectAllowed: "none" } });
  row("a.md").dispatchEvent(event);
  expect(setData).toHaveBeenCalledWith("text/plain", "a.md");
});
