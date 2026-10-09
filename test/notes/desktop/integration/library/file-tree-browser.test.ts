/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let target: HTMLDivElement;
let component: LibraryBrowser;
let workspace: ReaderWorkspaceController;
let api: ReturnType<typeof createReaderApiMock>;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};
const card = (path: string) =>
  target.querySelector<HTMLButtonElement>(`button[data-path="${path}"]`)!;
const press = async (path: string, key: string, options: KeyboardEventInit = {}) => {
  card(path).focus();
  card(path).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
  await settle();
};

beforeEach(async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(460);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "docs", kind: "directory" },
      { path: "docs/nested.md", kind: "file" },
      ...["a.md", "b.md", "c.md", "d.md"].map((path) => ({ path, kind: "file" as const })),
    ]),
    vaultList: vi.fn(async () => ["a.md", "b.md", "c.md", "d.md", "docs/nested.md"]),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(LibraryBrowser, {
    target,
    props: { workspace, onEdit: vi.fn(), onOpen: vi.fn() },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  workspace.fileTree.reset();
  target.remove();
  vi.restoreAllMocks();
});

it("层级列表按可见行连续选择，修饰键只移动焦点", async () => {
  expect(target.querySelector('[role="treegrid"]')?.getAttribute("aria-colcount")).toBe("1");
  card("a.md").click();
  await press("a.md", "ArrowDown", { shiftKey: true });
  expect(workspace.fileTree.state.selected).toEqual(["a.md", "b.md"]);
  expect(document.activeElement).toBe(card("b.md"));
  await press("b.md", "ArrowUp", { ctrlKey: true });
  expect(workspace.fileTree.state.selected).toEqual(["a.md", "b.md"]);
  expect(document.activeElement).toBe(card("a.md"));
  await press("a.md", "ArrowDown");
  expect(document.activeElement).toBe(card("b.md"));
  expect(workspace.fileTree.state.selected).toEqual(["b.md"]);
});

it("当前文件高亮跟随已打开文档，键盘焦点和批量选择不改写它", async () => {
  card("a.md").click();
  await vi.waitFor(() => {
    flushSync();
    expect(workspace.document.path).toBe("a.md");
  });
  await press("a.md", "ArrowDown", { ctrlKey: true });
  expect(document.activeElement).toBe(card("b.md"));
  expect(card("a.md").closest(".file-row")?.classList.contains("active")).toBe(true);
  expect(card("b.md").closest(".file-row")?.classList.contains("active")).toBe(false);
  await press("b.md", "ArrowDown", { shiftKey: true });
  expect(workspace.fileTree.state.selected).toEqual(["a.md", "b.md", "c.md"]);
  expect(card("a.md").getAttribute("aria-current")).toBe("page");
  expect(card("c.md").closest(".file-row")?.classList.contains("active")).toBe(false);
});

it("统一展开按钮只调整层级，不改变文件选择或当前文档", async () => {
  card("a.md").click();
  await vi.waitFor(() => {
    flushSync();
    expect(workspace.document.path).toBe("a.md");
  });
  const folder = card("docs").closest(".file-row")!;
  const toggle = folder.querySelector<HTMLButtonElement>(".tree-toggle");
  expect(toggle).not.toBeNull();
  expect(
    toggle!.compareDocumentPosition(card("docs")) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  toggle!.click();
  await settle();
  expect(card("docs/nested.md")).not.toBeNull();
  expect(workspace.fileTree.state.selected).toEqual(["a.md"]);
  expect(workspace.document.path).toBe("a.md");
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  toggle!.click();
  await settle();
  expect(card("docs/nested.md")).toBeNull();
  expect(workspace.document.path).toBe("a.md");
});

it("展开按钮分离后，文件夹整行仍是可用的拖放目标", () => {
  card("a.md").dispatchEvent(new Event("dragstart", { bubbles: true }));
  flushSync();
  const folder = card("docs").closest(".file-row")!;
  const arrow = folder.querySelector<HTMLButtonElement>(".tree-toggle")!;
  const over = new Event("dragover", { bubbles: true, cancelable: true });
  arrow.dispatchEvent(over);
  flushSync();
  expect(over.defaultPrevented).toBe(true);
  expect(folder.classList.contains("drop-target")).toBe(true);
  card("a.md").dispatchEvent(new Event("dragend", { bubbles: true }));
  flushSync();
  expect(folder.classList.contains("drop-target")).toBe(false);
});

it("文件拖出提供库归属及完整多选身份，允许 Agent 复制且目录内部仍允许移动", () => {
  workspace.fileTree.update({ selected: ["a.md", "b.md"] });
  flushSync();
  const values = new Map<string, string>();
  const transfer = { effectAllowed: "none", setData: (type: string, value: string) => values.set(type, value) };
  const event = new Event("dragstart", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  card("a.md").dispatchEvent(event);
  expect(transfer.effectAllowed).toBe("copyMove");
  expect(JSON.parse(values.get("application/x-noemori-library-entries")!)).toEqual({
    root: "/notes", entries: [{ path: "a.md", kind: "file" }, { path: "b.md", kind: "file" }],
  });
  expect(values.get("text/plain")).toBe("a.md\nb.md");
  const over = new Event("dragover", { bubbles: true, cancelable: true });
  const destination = { dropEffect: "none" };
  Object.defineProperty(over, "dataTransfer", { value: destination });
  card("docs").dispatchEvent(over);
  expect(destination.dropEffect).toBe("move");
  card("a.md").dispatchEvent(new Event("dragend", { bubbles: true }));
  expect(api.entryBatch).not.toHaveBeenCalled();
});

it("滚动事件尚未交付时切换查询，也能恢复浏览时的真实滚动位置", async () => {
  vi.mocked(api.vaultEntries).mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => ({
      path: `note${index}.md`,
      kind: "file" as const,
    })),
  );
  await workspace.refreshList();
  flushSync();
  const grid = target.querySelector<HTMLDivElement>('[role="treegrid"]')!;
  // jsdom 不执行浏览器的滚动范围夹取，按实际已渲染高度补齐此行为。
  let scrollOffset = 0;
  Object.defineProperty(grid, "scrollTop", {
    get: () => scrollOffset,
    set: (value: number) => {
      const height = Number.parseFloat(grid.querySelector<HTMLElement>(".extent")!.style.height);
      scrollOffset = Math.max(0, Math.min(value, Math.max(0, height - grid.clientHeight)));
    },
  });
  grid.scrollTop = 600;
  const input = target.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  input.value = "note1.md";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(grid.scrollTop).toBe(0);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  expect(grid.scrollTop).toBe(600);
  expect(workspace.fileTree.state.scroll).toEqual({ path: "note20.md", offset: 0 });
});

it("文件和对话共用一个键盘入口，对话当前状态不混入文件批量选择", async () => {
  await unmount(component);
  workspace.fileTree.update({ discussions: { expanded: ["a.md"], archived: false, scroll: null } });
  component = mount(LibraryBrowser, {
    target,
    props: {
      workspace,
      onEdit: vi.fn(),
      onOpen: vi.fn(),
      conversations: {
        selected: "chat",
        open: vi.fn(),
        create: vi.fn(),
        manage: vi.fn(),
        items: [
          {
            id: "chat",
            title: "笔记讨论",
            workspace: "/notes",
            archived: false,
            updatedAt: 1,
            article: { path: "a.md", title: "a", status: "located" },
            origin: null,
            status: null,
          },
        ],
      },
    },
  });
  flushSync();
  card("a.md").click();
  await vi.waitFor(() => {
    flushSync();
    expect(workspace.document.path).toBe("a.md");
  });
  const chat = target.querySelector<HTMLButtonElement>('.file[aria-label="笔记讨论"]')!;
  chat.focus();
  flushSync();
  expect(target.querySelectorAll('[role="treegrid"] button[data-path][tabindex="0"]')).toHaveLength(
    1,
  );
  expect(chat.getAttribute("tabindex")).toBe("0");
  expect(chat.closest('[role="gridcell"]')?.getAttribute("aria-selected")).toBe("false");
  expect(chat.getAttribute("aria-pressed")).toBe("true");
  expect(chat.closest(".file-row")?.textContent).not.toContain("对话中");
  expect(chat.querySelector(".conversation-active")).not.toBeNull();
  expect(card("a.md").closest(".file-row")?.classList.contains("active")).toBe(true);
});

it("仓库标题没有点击动作，目录菜单将创建和导入定位到该目录", async () => {
  await unmount(component);
  const onEdit = vi.fn();
  component = mount(LibraryBrowser, { target, props: { workspace, onEdit, onOpen: vi.fn() } });
  workspace.fileTree.enterDirectory("docs");
  await settle();
  const before = structuredClone(workspace.fileTree.state);
  target.querySelector<HTMLElement>(".root-label")!.click();
  flushSync();
  expect(workspace.fileTree.state).toEqual(before);
  expect(onEdit).not.toHaveBeenCalled();
  for (const [label, action] of [["新建子文件夹…", "directory"], ["导入文件夹…", "import"]]) {
    card("docs").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
    await settle();
    const button = [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === label)!;
    button.click();
    expect(onEdit).toHaveBeenLastCalledWith(action, null, "docs");
  }
});

it("单击文件夹展开，搜索清空后恢复原选择与目录层级", async () => {
  card("docs").click();
  flushSync();
  expect(card("docs/nested.md")).not.toBeNull();
  card("docs").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
  expect(card("docs/nested.md")).not.toBeNull();
  expect(card("a.md")).not.toBeNull();
  expect(workspace.fileTree.state.browse?.directory).toBe("docs");
  const search = target.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  search.value = "a.md";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(card("a.md")).not.toBeNull();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  expect(card("a.md")).not.toBeNull();
  expect(card("docs/nested.md")).not.toBeNull();
});

it("同一库恢复浏览现场时，目录、查询与分类统一来自会话状态", async () => {
  workspace.fileTree.update({ browse: { directory: "docs", query: "a.md", section: "files" } });
  await settle();
  expect(target.querySelector<HTMLInputElement>('[role="searchbox"]')!.value).toBe("a.md");
  expect(card("a.md")).not.toBeNull();
  expect(card("docs/nested.md")).toBeNull();
  workspace.fileTree.update({ browse: { directory: "docs", query: "", section: "bookmarks" } });
  await settle();
  expect(target.querySelector('[role="treegrid"]')).not.toBeNull();
  expect(target.querySelector(".bookmarks")).toBeNull();
  workspace.fileTree.update({
    expanded: ["docs"],
    browse: { directory: "docs", query: "", section: "files" },
  });
  await settle();
  expect(card("docs/nested.md")).not.toBeNull();
  expect(card("a.md")).not.toBeNull();
});


it("连续点选合并等待中的打开请求，最终文档与最后选择一致", async () => {
  const first = Promise.withResolvers<{ disk: Uint8Array; draft: null }>();
  vi.mocked(api.fileSnapshot).mockImplementation(async path => path === "a.md" ? first.promise : { disk: new TextEncoder().encode(path), draft: null });
  card("a.md").click();
  await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledWith("a.md"));
  card("b.md").click(); card("c.md").click(); flushSync();
  first.resolve({ disk: new TextEncoder().encode("a.md"), draft: null });
  await vi.waitFor(() => { flushSync(); expect(workspace.document.path).toBe("c.md"); });
  expect(api.fileSnapshot).not.toHaveBeenCalledWith("b.md");
  expect(workspace.fileTree.state.selected).toEqual(["c.md"]);
});

it.each(["tags", "bookmarks"] as const)("目录工具只保留库名与更多，旧 %s 与排序偏好恢复为文件浏览", async (section) => {
  workspace.fileTree.restore({
    expanded: [], selected: [], focused: null, scroll: null,
    browse: { query: "", section, directory: "docs" },
    presentation: { layout: "list", sort: "name-desc", preview: true },
  }, workspace.entries);
  await settle();
  expect([...target.querySelectorAll(".view-options > button")].map(button => button.getAttribute("aria-label")))
    .toEqual(["目录操作"]);
  expect(target.querySelector(".root-label h2")?.textContent).toBe("Noemori");
  expect(target.querySelector('button[aria-label="笔记库根目录"]')).toBeNull();
  expect(target.querySelector(".result-count")).toBeNull();
  expect(target.querySelector('[aria-label="文件排序"]')).toBeNull();
  expect(target.querySelector(".tags")).toBeNull();
  expect([...target.querySelectorAll(".file[data-path]")].map(button => button.getAttribute("data-path")))
    .toEqual(["docs", "a.md", "b.md", "c.md", "d.md"]);
  expect(api.bookmarksList).not.toHaveBeenCalled();
});
