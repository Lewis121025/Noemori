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
  await vi.waitFor(() => { flushSync(); expect(workspace.document.path).toBe("a.md"); });
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
  await vi.waitFor(() => { flushSync(); expect(workspace.document.path).toBe("a.md"); });
  const folder = card("docs").closest(".file-row")!;
  const toggle = folder.querySelector<HTMLButtonElement>(".tree-toggle");
  expect(toggle).not.toBeNull();
  expect(toggle!.compareDocumentPosition(card("docs")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

it("文件和对话共用一个键盘入口，对话当前状态不混入文件批量选择", async () => {
  await unmount(component);
  workspace.fileTree.update({ discussions: { expanded: ["a.md"], archived: false, scroll: null } });
  component = mount(LibraryBrowser, { target, props: {
    workspace, onEdit: vi.fn(), onOpen: vi.fn(),
    conversations: { selected: "chat", open: vi.fn(), create: vi.fn(), manage: vi.fn(), items: [
      { id: "chat", title: "笔记讨论", workspace: "/notes", archived: false, updatedAt: 1,
        article: { path: "a.md", title: "a", status: "located" }, origin: null, status: null },
    ] },
  } });
  flushSync();
  card("a.md").click();
  await vi.waitFor(() => { flushSync(); expect(workspace.document.path).toBe("a.md"); });
  const chat = target.querySelector<HTMLButtonElement>('.file[aria-label="笔记讨论"]')!;
  chat.focus();
  flushSync();
  expect(target.querySelectorAll('[role="treegrid"] button[data-path][tabindex="0"]')).toHaveLength(1);
  expect(chat.getAttribute("tabindex")).toBe("0");
  expect(chat.closest('[role="gridcell"]')?.getAttribute("aria-selected")).toBe("false");
  expect(chat.getAttribute("aria-pressed")).toBe("true");
  expect(chat.closest(".file-row")?.textContent).toContain("对话中");
  expect(card("a.md").closest(".file-row")?.classList.contains("active")).toBe(true);
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
    .toEqual(["笔记库根目录", "目录操作"]);
  expect(target.querySelector(".result-count")).toBeNull();
  expect(target.querySelector('[aria-label="文件排序"]')).toBeNull();
  expect(target.querySelector(".tags")).toBeNull();
  expect([...target.querySelectorAll(".file[data-path]")].map(button => button.getAttribute("data-path")))
    .toEqual(["docs", "a.md", "b.md", "c.md", "d.md"]);
  expect(api.bookmarksList).not.toHaveBeenCalled();
});
