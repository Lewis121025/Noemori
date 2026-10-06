/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FolderNavigation from "@reader/renderer/library/FolderNavigation.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let target: HTMLDivElement;
let component: FolderNavigation;
let workspace: ReaderWorkspaceController;
let entries: VaultEntry[];
let navigate: ReturnType<typeof vi.fn>;
const folder = (path: string) =>
  target.querySelector<HTMLButtonElement>(`[data-directory="${path}"]`)!;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

beforeEach(async () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  entries = [
    { path: "docs", kind: "directory" },
    { path: "docs/sub", kind: "directory" },
    { path: "docs/sub/a.md", kind: "file" },
    { path: "empty", kind: "directory" },
  ];
  const api = createReaderApiMock({
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
    entryTrash: vi.fn(async (path) => {
      entries = entries.filter(
        (entry) => entry.path !== path && !entry.path.startsWith(`${path}/`),
      );
      return { warning: null };
    }),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  navigate = vi.fn((path: string) => workspace.fileTree.enterDirectory(path));
  target = document.createElement("div");
  document.body.append(target);
  component = mount(FolderNavigation, { target, props: { workspace, onNavigate: navigate } });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  workspace.fileTree.reset();
  for (const pane of workspace.panes) pane.dispose();
  target.remove();
  vi.restoreAllMocks();
});

it("展开与方向键只改变树的焦点，选择目录才清理网格现场", async () => {
  workspace.fileTree.update({
    selected: ["docs/sub/a.md"],
    focused: "docs/sub/a.md",
    scroll: { path: "docs/sub/a.md", offset: 12 },
    browse: { query: "a.md", directory: "", section: "files" },
  });
  flushSync();
  folder("docs").focus();
  folder("docs").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await settle();
  expect(folder("docs/sub")).not.toBeNull();
  expect(workspace.fileTree.state.selected).toEqual(["docs/sub/a.md"]);
  expect(navigate).not.toHaveBeenCalled();
  folder("docs").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await settle();
  expect(document.activeElement).toBe(folder("docs/sub"));
  folder("docs/sub").click();
  flushSync();
  expect(workspace.fileTree.state.browse).toEqual({
    query: "",
    directory: "docs/sub",
    section: "files",
  });
  expect(workspace.fileTree.state.selected).toEqual([]);
  expect(workspace.fileTree.state.scroll).toBeNull();
  expect(navigate).toHaveBeenCalledOnce();
  folder("docs/sub").dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  await settle();
  expect(document.activeElement).toBe(folder("docs"));
  folder("docs")
    .querySelector(".disclosure")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
  expect(folder("docs/sub")).toBeNull();
  expect(workspace.fileTree.state.browse?.directory).toBe("docs/sub");
});

it("目录改名和删除通过同一会话映射迁移高亮，删除后回到根目录", async () => {
  workspace.fileTree.enterDirectory("docs/sub");
  flushSync();
  expect(folder("docs/sub").getAttribute("aria-current")).toBe("location");
  expect(await workspace.renameEntry("docs", "renamed")).toBeNull();
  await settle();
  expect(folder("renamed/sub").getAttribute("aria-current")).toBe("location");
  expect(folder("docs")).toBeNull();
  folder("renamed/sub").focus();
  expect(document.activeElement).toBe(folder("renamed/sub"));
  expect(await workspace.trashEntry("renamed")).toBeNull();
  await settle();
  expect(folder("").getAttribute("aria-current")).toBe("location");
  expect(document.activeElement).toBe(folder(""));
});

it("长目录导航虚拟化且独立保存滚动，End 可聚焦未挂载目录", async () => {
  entries = Array.from({ length: 1000 }, (_, index) => ({
    path: `folder-${index}`,
    kind: "directory",
  }));
  await workspace.refreshList();
  flushSync();
  expect(target.querySelectorAll('[role="treeitem"]').length).toBeLessThan(100);
  workspace.fileTree.update({ scroll: { path: "folder-0", offset: 8 } });
  folder("folder-0").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await settle();
  expect(document.activeElement).toBe(folder("folder-999"));
  expect(workspace.fileTree.state.navigationScroll?.path).toBe("folder-990");
  expect(workspace.fileTree.state.scroll).toEqual({ path: "folder-0", offset: 8 });
});
