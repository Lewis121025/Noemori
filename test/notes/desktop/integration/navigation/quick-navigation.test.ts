/** @vitest-environment jsdom */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickNavigation from "@reader/renderer/navigation/QuickNavigation.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { ReaderApi, VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let component: QuickNavigation;
let target: HTMLDivElement;
let workspace: ReaderWorkspaceController;
let stop: () => void;
let api: ReaderApi;
const onOpen = vi.fn();
const onTrash = vi.fn();
const paths = ["想法.md", "工作/计划.md", "生活/计划.md"];
const input = () => target.querySelector<HTMLInputElement>("input")!;
const rows = () => [...target.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];

beforeEach(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => paths.map((path) => ({ path, kind: "file" as const }))),
  });
  workspace = new ReaderWorkspaceController(api);
  stop = workspace.start();
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(QuickNavigation, {
    target,
    props: {
      workspace,
      hidden: false,
      width: 232,
      onWidth: vi.fn(),
      onOpen,
      onTrash,
    },
  });
  flushSync();
  Object.defineProperty(target.querySelector("[role=tree]"), "clientHeight", { value: 352 });
});

afterEach(async () => {
  await unmount(component);
  stop();
  target.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function press(element: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  element.dispatchEvent(event);
  flushSync();
  return event;
}

function search(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("读写中的当前笔记库目录树", () => {
  it("方向键和首尾键移动焦点而不打开文件，列表只占用一个 Tab 位置", async () => {
    input().focus();
    expect(press(input(), "ArrowDown").defaultPrevented).toBe(true);
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[0]));
    press(rows()[0]!, "ArrowDown");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[1]]);
    press(rows()[1]!, "End");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[2]));
    press(rows()[2]!, "Home");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[0]));
    press(rows()[0]!, "Escape");
    expect(document.activeElement).toBe(input());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("按真实目录展开同名文件，点击目录不打开文档，文件使用完整路径打开", () => {
    expect(rows().map((row) => row.dataset.path)).toEqual(["工作", "生活", "想法.md"]);
    rows()[0]!.click();
    flushSync();
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    const work = rows().find((row) => row.dataset.path === "工作/计划.md")!;
    expect(work.title).toBe("工作/计划.md");
    expect(work.getAttribute("aria-level")).toBe("2");
    expect(onOpen).not.toHaveBeenCalled();
    work.click();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("工作/计划.md");
    expect(work.getAttribute("aria-selected")).toBe("false");
    rows()[0]!.click();
    flushSync();
    expect(rows().map((row) => row.dataset.path)).not.toContain("工作/计划.md");
  });

  it("短目录没有实际滚动时，展开当前笔记前面的文件夹不能把它推到视口外", async () => {
    vi.mocked(api.vaultEntries).mockResolvedValue([
      ...paths.map((path): VaultEntry => ({ path, kind: "file" })),
      ...Array.from({ length: 30 }, (_, index): VaultEntry => ({
        path: `工作/资料${index}.md`,
        kind: "file",
      })),
    ]);
    await workspace.refreshList();
    flushSync();
    const tree = target.querySelector<HTMLElement>('[role="tree"]')!;
    let scroll = 0;
    // 模拟浏览器把短列表的滚动请求夹到 0；这里不会产生 scroll 事件。
    Object.defineProperty(tree, "scrollTop", {
      get: () => scroll,
      set: (value: number) => {
        const extent = Number.parseFloat(tree.querySelector<HTMLElement>(".extent")!.style.height);
        scroll = Math.max(0, Math.min(value, extent - tree.clientHeight));
      },
    });
    await workspace.openFile("想法.md");
    flushSync();
    await tick();
    expect(tree.scrollTop).toBe(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      rows()
        .find((row) => row.dataset.path === "工作")!
        .click();
      flushSync();
      await tick();
      expect(tree.scrollTop).toBe(0);
    }
  });

  it("切换到视口内的文件时保留滚动位置，不把活动文件强制顶到列表开头", async () => {
    vi.mocked(api.vaultEntries).mockResolvedValue(
      Array.from({ length: 30 }, (_, index): VaultEntry => ({
        path: `笔记${index}.md`,
        kind: "file",
      })),
    );
    await workspace.refreshList();
    flushSync();
    const tree = target.querySelector<HTMLElement>('[role="tree"]')!;
    tree.scrollTop = 352;
    tree.dispatchEvent(new Event("scroll"));
    flushSync();
    await workspace.openFile("笔记12.md");
    flushSync();
    await tick();
    expect(tree.scrollTop).toBe(352);
  });

  it("文件与文件夹的删除按钮只请求确认，不打开文件或修改目录", () => {
    target.querySelector<HTMLButtonElement>('[aria-label="将 想法.md 移到废纸篓"]')!.click();
    expect(onTrash).toHaveBeenLastCalledWith({ path: "想法.md", kind: "file" });
    target.querySelector<HTMLButtonElement>('[aria-label="将 工作 移到废纸篓"]')!.click();
    expect(onTrash).toHaveBeenLastCalledWith({ path: "工作", kind: "directory" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(api.entryTrash).not.toHaveBeenCalled();
    expect(rows().map((row) => row.dataset.path)).toEqual(["工作", "生活", "想法.md"]);
  });

  it("Delete 与 macOS 删除快捷键使用焦点条目，长按和输入法确认不会重复请求", () => {
    const folder = rows()[0]!;
    folder.focus();
    expect(press(folder, "Delete").defaultPrevented).toBe(true);
    expect(onTrash).toHaveBeenCalledExactlyOnceWith({ path: "工作", kind: "directory" });
    onTrash.mockClear();
    press(folder, "Delete", { repeat: true });
    press(folder, "Delete", { shiftKey: true });
    press(folder, "Backspace");
    expect(onTrash).not.toHaveBeenCalled();
    press(folder, "Backspace", { metaKey: true });
    expect(onTrash).toHaveBeenCalledExactlyOnceWith({ path: "工作", kind: "directory" });
    onTrash.mockClear();
    folder.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    press(folder, "Delete");
    expect(onTrash).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("左右方向键展开、进入子项、回到父级并收起，目录导航不修改资料管理状态", async () => {
    const before = structuredClone(workspace.fileTree.state);
    rows()[0]!.focus();
    press(rows()[0]!, "ArrowRight");
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    press(rows()[0]!, "ArrowRight");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    press(rows()[1]!, "ArrowLeft");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[0]));
    press(rows()[0]!, "ArrowLeft");
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(workspace.fileTree.state).toEqual(before);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("搜索保留匹配文件的祖先，清除搜索恢复原折叠现场", () => {
    search("计划");
    expect(rows().map((row) => row.dataset.path)).toEqual([
      "工作",
      "工作/计划.md",
      "生活",
      "生活/计划.md",
    ]);
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    search("");
    expect(rows().map((row) => row.dataset.path)).toEqual(["工作", "生活", "想法.md"]);
  });

  it("打开深层文档后自动展开并高亮，根目录仍包含其他文件夹", async () => {
    await workspace.openFile("工作/计划.md");
    flushSync();
    expect(
      rows()
        .find((row) => row.dataset.path === "工作/计划.md")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    expect(rows().map((row) => row.dataset.path)).toContain("生活");
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("完整清单包含空目录和附件，超过旧上限的文件仍可通过键盘访问", async () => {
    const entries: VaultEntry[] = [
      { path: "空目录", kind: "directory" },
      { path: "图片.png", kind: "file" },
      { path: "画布.noemoriboard", kind: "file" },
      ...Array.from({ length: 140 }, (_, index): VaultEntry => ({
        path: `资料${index}.md`,
        kind: "file",
      })),
    ];
    vi.mocked(api.vaultEntries).mockResolvedValue(entries);
    await workspace.refreshList();
    flushSync();
    expect(rows().map((row) => row.dataset.path)).toContain("空目录");
    expect(rows().map((row) => row.dataset.path)).toContain("图片.png");
    expect(rows().map((row) => row.dataset.path)).toContain("画布.noemoriboard");
    press(input(), "ArrowDown");
    await tick();
    press(rows()[0]!, "End");
    await tick();
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-path")).toBe("资料139.md"),
    );
    expect(rows().length).toBeLessThan(100);
    search("资料139");
    expect(rows().map((row) => row.dataset.path)).toEqual(["资料139.md"]);
  });

  it("切库后清除旧查询与展开现场，只显示新库条目", async () => {
    rows()[0]!.click();
    search("计划");
    vi.mocked(api.vaultEntries).mockResolvedValue([{ path: "新库.md", kind: "file" }]);
    vi.mocked(api.vaultOpen).mockResolvedValue({
      root: "/other",
      entries: await api.vaultEntries(),
    });
    await workspace.openVault();
    flushSync();
    expect(input().value).toBe("");
    expect(rows().map((row) => row.dataset.path)).toEqual(["新库.md"]);
    expect(target.querySelector(".caption")?.textContent).toContain("other");
  });

  it("目录刷新反映外部增删，空库提供提示", async () => {
    vi.mocked(api.vaultEntries).mockResolvedValue([{ path: "新增.md", kind: "file" }]);
    await workspace.refreshList();
    flushSync();
    expect(rows().map((row) => row.dataset.path)).toEqual(["新增.md"]);
    vi.mocked(api.vaultEntries).mockResolvedValue([]);
    await workspace.refreshList();
    flushSync();
    expect(rows()).toHaveLength(0);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("当前笔记库为空");
  });

  it("查无结果时解释状态，清除搜索后焦点与候选恢复", () => {
    search("不存在的内容");
    expect(rows()).toHaveLength(0);
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      "没有匹配的文件或文件夹",
    );
    const clear = target.querySelector<HTMLButtonElement>('[aria-label="清除快速查找"]')!;
    expect(clear).not.toBeNull();
    clear.click();
    flushSync();
    expect(input().value).toBe("");
    expect(rows()).toHaveLength(3);
    expect(document.activeElement).toBe(input());
  });

  it("确认中文候选期间，不从搜索框意外打开文件", (t) => {
    const parentKeydown = vi.fn();
    window.addEventListener("keydown", parentKeydown);
    t.onTestFinished(() => window.removeEventListener("keydown", parentKeydown));
    search("想法");
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    press(input(), "Enter");
    expect(onOpen).not.toHaveBeenCalled();
    press(input(), "Escape");
    expect(parentKeydown).not.toHaveBeenCalled();
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    press(input(), "Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("想法.md");
    onOpen.mockClear();
    press(input(), "Enter", { isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
