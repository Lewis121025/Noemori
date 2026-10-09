/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";
import type { SearchHit } from "@reader/shared/api";

let target: HTMLDivElement, view: LibraryBrowser, workspace: ReaderWorkspaceController;
let api: ReturnType<typeof createReaderApiMock>;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};
const row = (path: string) =>
  target.querySelector<HTMLButtonElement>(`button[data-path="${path}"]`)!;
const query = (text: string, composing = false) => {
  const input = target.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: composing }));
  flushSync();
  return input;
};
const key = async (path: string, key: string, init: KeyboardEventInit = {}) => {
  row(path).focus();
  row(path).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  await settle();
};
const hit = (path: string): SearchHit => ({
  path,
  title: "波前",
  snippet: "研究\u0001光的传播\u0002过程",
  contentHash: "0".repeat(64),
  matches: [],
  matchCount: 0,
  matchesCursor: null,
});
beforeEach(async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "docs", kind: "directory" },
      { path: "docs/sub", kind: "directory" },
      { path: "docs/sub/wave.md", kind: "file" },
      { path: "empty", kind: "directory" },
    ]),
    fileRead: vi.fn(async () =>
      new TextEncoder().encode("# 波前\n\n光的传播过程。光的传播速度。\n"),
    ),
    searchQuery: vi.fn(async () => ({ hits: [hit("docs/sub/wave.md")], nextCursor: null })),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  view = mount(LibraryBrowser, {
    target,
    props: { workspace, onEdit: vi.fn(), onOpen: vi.fn() },
  });
  flushSync();
});
afterEach(async () => {
  await unmount(view);
  workspace.fileTree.reset();
  workspace.search.reset();
  target.remove();
  vi.restoreAllMocks();
});

it("左右键展开、进入和返回父目录，折叠不把隐藏条目纳入连续选择", async () => {
  await key("docs", "ArrowRight");
  expect(row("docs/sub")).not.toBeNull();
  await key("docs", "ArrowRight");
  expect(document.activeElement).toBe(row("docs/sub"));
  await key("docs/sub", "ArrowRight");
  expect(row("docs/sub/wave.md")).not.toBeNull();
  await key("docs/sub/wave.md", "ArrowLeft");
  expect(document.activeElement).toBe(row("docs/sub"));
  await key("docs/sub", "ArrowLeft");
  expect(row("docs/sub/wave.md")).toBeNull();
  row("docs").click();
  await settle();
  row("empty").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  flushSync();
  expect(workspace.fileTree.state.selected).toEqual(["docs", "empty"]);
});

it("正文结果保留祖先与摘录，单击进入共享文档", async () => {
  query("光的传播");
  await vi.waitFor(() => { flushSync(); expect(row("docs/sub/wave.md")).not.toBeNull(); });
  expect(row("docs/sub/wave.md").querySelector(".excerpt mark")?.textContent).toBe("光的传播");
  expect(row("docs")).not.toBeNull();
  row("docs/sub/wave.md").click();
  await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledWith("docs/sub/wave.md"));
  expect(target.querySelector(".library-document")).toBeNull();
});

it("拼音组词期间不检索，迟到的旧结果不能覆盖新关键词", async () => {
  const input = query("guang", true);
  await new Promise((resolve) => setTimeout(resolve, 280));
  expect(api.searchQuery).not.toHaveBeenCalled();
  let resolve!: (value: { hits: SearchHit[]; nextCursor: null }) => void;
  vi.mocked(api.searchQuery).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  input.value = "光的传播";
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalledOnce());
  query("不存在");
  vi.mocked(api.searchQuery).mockResolvedValue({ hits: [], nextCursor: null });
  resolve({ hits: [hit("docs/sub/wave.md")], nextCursor: null });
  await settle();
  expect(row("docs/sub/wave.md")).toBeNull();
  await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalledTimes(2));
  expect(row("docs/sub/wave.md")).toBeNull();
});

it("搜索全选只选择命中项，不把用于说明位置的上级目录加入批量操作", async () => {
  const input = query("光的传播");
  await vi.waitFor(() => {
    flushSync();
    expect(row("docs/sub/wave.md")).not.toBeNull();
  });
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle();
  expect(document.activeElement).toBe(row("docs/sub/wave.md"));
  await key("docs/sub/wave.md", "a", { metaKey: true });
  expect(workspace.fileTree.state.selected).toEqual(["docs/sub/wave.md"]);
});

it("跨目录连续选择文件时排除分组文件夹，避免文件操作扩大到未选中的兄弟文件", async () => {
  vi.mocked(api.vaultEntries).mockResolvedValueOnce([
    { path: "outside.md", kind: "file" },
    { path: "docs/sub/wave.md", kind: "file" },
  ]);
  await workspace.refreshList();
  await key("docs", "ArrowRight");
  await key("docs/sub", "ArrowRight");
  row("outside.md").click();
  row("docs/sub/wave.md").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  flushSync();
  expect(workspace.fileTree.state.selected).toEqual(["docs/sub/wave.md", "outside.md"]);
});

it("未打开笔记库时，独立对话仍能搜索并从搜索框用键盘进入，文件搜索不会报无库错误", async () => {
  await unmount(view);
  vi.mocked(api.vaultRestore).mockResolvedValue(null);
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  view = mount(LibraryBrowser, { target, props: {
    workspace, onEdit: vi.fn(), onOpen: vi.fn(),
    conversations: { selected: null, open: vi.fn(), create: vi.fn(), manage: vi.fn(), items: [
      { id: "independent", title: "独立研究", workspace: "/projects/research", archived: false, updatedAt: 1, origin: null, article: null, status: null },
    ] },
  } });
  flushSync();
  const input = query("独立研究");
  await new Promise(resolve => setTimeout(resolve, 280)); flushSync();
  const chat = [...target.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === "独立研究");
  expect(chat).toBeDefined();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle();
  expect(document.activeElement?.getAttribute("data-path")).toBe("\0workspace:/projects/research");
  expect(api.searchQuery).not.toHaveBeenCalled();
});
