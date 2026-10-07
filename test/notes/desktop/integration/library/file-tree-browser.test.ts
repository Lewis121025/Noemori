/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let target: HTMLDivElement;
let component: LibraryBrowser;
let workspace: ReaderWorkspaceController;
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
  const api = createReaderApiMock({
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
    props: { workspace, readFile: api.fileRead, onEdit: vi.fn(), onOpen: vi.fn() },
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
  expect(target.querySelector('[role="treegrid"]')).toBeNull();
  expect(target.querySelector(".bookmarks")).not.toBeNull();
  workspace.fileTree.update({
    expanded: ["docs"],
    browse: { directory: "docs", query: "", section: "files" },
  });
  await settle();
  expect(card("docs/nested.md")).not.toBeNull();
  expect(card("a.md")).not.toBeNull();
});
