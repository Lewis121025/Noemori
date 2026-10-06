/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@app/App.svelte";
import { createAppApiMock } from "../../fixtures/app-api-mock";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";
import { emptyReaderSession } from "@reader/shared/session";
import type {
  AppApi,
  AppCommand,
} from "../../../../../modules/notes/packages/desktop/src/shared/api";
import type {
  FileSnapshot,
  Mentions,
  ReaderApi,
  SavedCopy,
  VaultRestore,
  WriteResult,
  VaultEvent,
} from "@reader/shared/api";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
let onClose: () => void;
let onCommand: (command: AppCommand) => void;
let onChanged: (event?: VaultEvent) => void;
let disk: Map<string, Uint8Array>;
let api: ReaderApi;
let appApi: AppApi;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  // jsdom 不执行布局，目录的真实测量与滚动由 Electron 用例覆盖。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  disk = new Map([
    ["note.md", encode("base\n")],
    ["other.md", encode("other\n")],
  ]);
  api = createReaderApiMock({
    exportRecover: vi.fn(async () => {}),
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      entries: await api.vaultEntries(),
      documents: {
        panes: [{ currentPath: "note.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: [],
      fileTree: null,
    })),
    vaultOpen: vi.fn(async () => null),
    vaultOpenCancel: vi.fn(async () => true),
    vaultCreateDefault: vi.fn(async () => ({ root: "/notes", entries: await api.vaultEntries() })),
    vaultClose: vi.fn(async () => {}),
    vaultList: vi.fn(async () => [...disk.keys()]),
    vaultEntries: vi.fn(async () =>
      (await api.vaultList()).map((path) => ({ path, kind: "file" as const })),
    ),
    entryCreate: vi.fn(async () => ({ warning: null })),
    attachmentImport: vi.fn(async (_root, _from, name) => ({
      path: `attachments/${name}`,
      warning: null,
    })),
    entryTrash: vi.fn(async () => ({ warning: null })),
    entryReveal: vi.fn(async () => {}),
    fileRead: vi.fn(async (path) => disk.get(path)!),
    fileSnapshot: vi.fn(async (path) => ({ disk: disk.get(path) ?? null, draft: null })),
    filePreserveDraft: vi.fn(async () => {}),
    fileWrite: vi.fn(async (path, bytes) => {
      disk.set(path, bytes);
      return { status: "saved" as const, warning: null };
    }),
    fileWriteCopy: vi.fn(async (_path, bytes) => {
      disk.set("note (副本).md", bytes);
      return { path: "note (副本).md", warning: null };
    }),
    sessionSetDocuments: vi.fn(async () => {}),
    sessionSetViewModes: vi.fn(async () => {}),
    sessionSetRecentFiles: vi.fn(async () => {}),
    sessionSetFileTree: vi.fn(async () => {}),
    sessionGetPanes: vi.fn(async () => ({ ...emptyReaderSession })),
    sessionSetPanes: vi.fn(async () => {}),
    linksResolve: vi.fn(async () => ({ status: "dead" as const })),
    openExternal: vi.fn(async () => {}),
    indexLinksTo: vi.fn(async () => []),
    indexLinksFrom: vi.fn(async () => []),
    indexMentionsTo: vi.fn(async () => ({ linked: [], unlinked: [] })),
    mentionsLinkify: vi.fn(async () => ({ warning: null })),
    searchQuery: vi.fn(async () => ({ hits: [], nextCursor: null })),
    searchCancel: vi.fn(async () => {}),
    indexHeadings: vi.fn(async () => []),
    indexTags: vi.fn(async () => []),
    indexNoteKeys: vi.fn(async () => []),
    bookmarksList: vi.fn(async () => []),
    bookmarksSet: vi.fn(async () => {}),
    entryRename: vi.fn(async () => ({ warning: null })),
    subscribeVaultChanged: (callback) => {
      onChanged = (event = { status: "changed", paths: [], healthy: true }) => callback(event);
      return () => {};
    },
  });
  appApi = createAppApiMock({
    subscribeCommand: (callback) => {
      onCommand = callback;
      return () => {};
    },
    subscribeFlushBeforeClose: (callback) => {
      onClose = callback;
      return () => {};
    },
  });
  window.noemori = { app: appApi, reader: api };
});

afterEach(async () => {
  vi.useRealTimers();
  await unmount(app);
  target.remove();
  document.documentElement.style.removeProperty("--font-document");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(App, { target });
  flushSync();
  // jsdom 尚未实现原生对话框；真实焦点、Escape 与遮罩在 Electron 测试中验证。
  const dialog = target.querySelector<HTMLDialogElement>(".entry-dialog")!;
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  const menu = target.querySelector<HTMLDivElement>(".file-menu")!;
  menu.showPopover = () => {};
  menu.hidePopover = () => {};
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".ProseMirror")).not.toBeNull();
    expect(target.querySelector("section[data-pane]")?.hasAttribute("inert")).toBe(false);
  });
}

function click(label: string): void {
  const scope = target.querySelector("dialog[open]") ?? target;
  const button = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  expect(button, label).toBeDefined();
  button!.click();
  flushSync();
}

async function edit(text: string): Promise<void> {
  const paragraph = target.querySelector(".ProseMirror p")!;
  paragraph.textContent = text;
  // 通过真实 ProseMirror 的 DOM 观察器提交编辑，避免只测试模拟的 dirty 标记。
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function status(): string | null {
  flushSync();
  return target.querySelector(".save-status")?.textContent ?? null;
}

function renameTo(name: string): void {
  click("重命名…");
  const input = target.querySelector<HTMLInputElement>("#entry-name")!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  target
    .querySelector(".entry-dialog form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
}

function selectAttachment(): void {
  const formatting = target.querySelector("[id^='editor-formatting']");
  if (!(formatting instanceof HTMLElement)) throw new Error("缺少格式面板");
  formatting.hidePopover = () => {};
  onCommand("insert-attachment");
  const input = target.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("缺少附件输入");
  const file = Object.assign(new File(["data"], "x.zip"), {
    arrayBuffer: async () => encode("data").buffer,
  });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // jsdom 不提供 Range 布局，避免触发滚动测量；真实焦点与滚动由 Electron 旅程检查。
  const editor = target.querySelector(".ProseMirror");
  if (editor instanceof HTMLElement) editor.blur();
}

async function manageFiles(): Promise<void> {
  onCommand("open-library");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector<HTMLElement>(".library")!.hidden).toBe(false);
  });
}

async function beginTrash(path: string): Promise<void> {
  await manageFiles();
  target
    .querySelector(`.library [data-path="${path}"]`)!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  flushSync();
  click("移到废纸篓…");
  click("移到废纸篓");
}
function openDocument(path: string): void {
  onCommand("quick-switcher");
  flushSync();
  const input = target.querySelector<HTMLInputElement>("dialog.picker input")!;
  input.value = path;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
}

async function requestToolbarTrash(path: string): Promise<void> {
  await manageFiles();
  const card = target.querySelector<HTMLButtonElement>(`.library button[data-path="${path}"]`)!;
  card.click();
  flushSync();
  target.querySelector<HTMLButtonElement>('.library-actions [aria-label="移到废纸篓"]')!.click();
  flushSync();
}

async function beginToolbarTrash(path: string): Promise<void> {
  await requestToolbarTrash(path);
  click("移到废纸篓");
}

describe("保存、冲突与恢复的完整界面流程", () => {
  it("外部刷新等待附件插入，完成后保留引用并报告版本冲突", async () => {
    const imported = deferred<{ path: string; warning: string | null }>();
    vi.mocked(api.attachmentImport).mockReturnValueOnce(imported.promise);
    await start();
    selectAttachment();
    await vi.waitFor(() => expect(api.attachmentImport).toHaveBeenCalledOnce());
    const originalEditor = target.querySelector(".ProseMirror");
    disk.set("note.md", encode("external\n"));
    onChanged();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledTimes(2));
    expect(target.querySelector(".ProseMirror")).toBe(originalEditor);
    imported.resolve({ path: "attachments/x.zip", warning: null });
    await vi.waitFor(() => {
      flushSync();
      expect(status()).toBe("存在保存冲突");
    });
    expect(target.querySelector(".ProseMirror")?.textContent).toContain("x.zip");
    expect(target.querySelector(".ProseMirror")?.textContent).toContain("base");
    expect(disk.get("note.md")).toEqual(encode("external\n"));
  });

  it("附件失败时刷新保留重试入口，明确关闭失败提示后读取最新外部版本", async () => {
    vi.mocked(api.attachmentImport).mockRejectedValueOnce(new Error("暂不可写"));
    await start();
    selectAttachment();
    await vi.waitFor(() =>
      expect(target.querySelector('.attachment-progress [role="alert"]')?.textContent).toContain(
        "暂不可写",
      ),
    );
    disk.set("note.md", encode("external\n"));
    onChanged();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledTimes(2));
    expect(target.querySelector(".attachment-progress")).not.toBeNull();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    const close = Array.from(
      target.querySelectorAll<HTMLButtonElement>(".attachment-progress button"),
    ).find((button) => button.textContent === "关闭");
    if (close === undefined) throw new Error("附件失败缺少关闭入口");
    close.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("external");
    });
  });

  it("关闭窗口等待附件导入与引用保存", async () => {
    const imported = deferred<{ path: string; warning: string | null }>();
    vi.mocked(api.attachmentImport).mockReturnValueOnce(imported.promise);
    await start();
    selectAttachment();
    await vi.waitFor(() => expect(api.attachmentImport).toHaveBeenCalledOnce());
    onClose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    imported.resolve({ path: "attachments/x.zip", warning: null });
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalledOnce());
    expect(decode(disk.get("note.md") ?? new Uint8Array())).toContain(
      "[x.zip](./attachments/x.zip)",
    );
  });

  it("切换文件也等待整批附件，引用保存在原笔记中", async () => {
    const imported = deferred<{ path: string; warning: string | null }>();
    vi.mocked(api.attachmentImport).mockReturnValueOnce(imported.promise);
    await start();
    selectAttachment();
    await vi.waitFor(() => expect(api.attachmentImport).toHaveBeenCalledOnce());
    openDocument("other.md");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
    imported.resolve({ path: "attachments/x.zip", warning: null });
    await vi.waitFor(() => expect(target.querySelector(".ProseMirror")?.textContent).toBe("other"));
    const call = vi.mocked(api.attachmentImport).mock.calls[0];
    expect(call?.slice(0, 3)).toEqual(["/notes", "note.md", "x.zip"]);
    expect(decode(call?.[3] ?? new Uint8Array())).toBe("data");
    expect(decode(disk.get("note.md") ?? new Uint8Array())).toContain("x.zip");
    expect(decode(disk.get("other.md") ?? new Uint8Array())).toBe("other\n");
  });

  it("附件失败阻止关闭，重试后保存引用再允许离开", async () => {
    vi.mocked(api.attachmentImport).mockRejectedValueOnce(new Error("磁盘已满"));
    await start();
    selectAttachment();
    await vi.waitFor(() =>
      expect(target.querySelector('.attachment-progress [role="alert"]')?.textContent).toContain(
        "磁盘已满",
      ),
    );
    onClose();
    await vi.waitFor(() => expect(appApi.closeBlocked).toHaveBeenCalledOnce());
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    click("重试剩余附件");
    const editor = target.querySelector(".ProseMirror");
    if (editor instanceof HTMLElement) editor.blur();
    await vi.waitFor(() => expect(target.querySelector(".attachment-progress")).toBeNull());
    onClose();
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalledOnce());
    expect(decode(disk.get("note.md") ?? new Uint8Array())).toContain("x.zip");
  });

  it("冲突另存副本也等待附件，复制包含最终引用且不再向旧文件提交", async () => {
    await start();
    await edit("working");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external"),
    });
    onCommand("save");
    await vi.waitFor(() => expect(target.querySelector(".save-notice")).not.toBeNull());
    const imported = deferred<{ path: string; warning: string | null }>();
    vi.mocked(api.attachmentImport).mockReturnValueOnce(imported.promise);
    selectAttachment();
    await vi.waitFor(() => expect(api.attachmentImport).toHaveBeenCalledOnce());
    click("另存为副本");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.fileWriteCopy).not.toHaveBeenCalled();
    imported.resolve({ path: "attachments/x.zip", warning: null });
    await vi.waitFor(() => expect(api.fileWriteCopy).toHaveBeenCalledOnce());
    expect(decode(disk.get("note (副本).md") ?? new Uint8Array())).toContain("x.zip");
    expect(api.fileWrite).toHaveBeenCalledTimes(1);
  });
  it("默认显示文件栏与正文，文档操作归属顶栏", async () => {
    await start();
    const toolbar = target.querySelector(".window-toolbar")!;
    expect(
      [...toolbar.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toContain("保存");
    expect(toolbar.textContent).not.toContain("文档内入链");
    expect(target.querySelector('aside[aria-label="文件栏"]')).not.toBeNull();
    expect(target.querySelector(".main .entry-dialog form")).toBeNull();
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    expect(target.querySelector(".references")).toBeNull();
    expect(target.querySelector(".save-status")?.classList.contains("quiet")).toBe(true);
    expect(target.textContent).not.toContain("钉住");
    expect(target.textContent).not.toContain("拆分");
  });

  it("焦点离开编辑器后，保存快捷键仍提交最新内容", async () => {
    await start();
    await edit("shortcut content");
    target.querySelector<HTMLButtonElement>(".file.active")!.focus();
    const event = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(decode(disk.get("note.md")!)).toBe("shortcut content\n");
  });

  it.each([false, true])(
    "重命名可以取消，空文件名留在对话框中处理（配色读取失败：%s）",
    async (paletteFailed) => {
      if (paletteFailed)
        vi.mocked(appApi.readingPaletteGet).mockRejectedValueOnce(new Error("配色读取不可用"));
      await start();
      renameTo("");
      await vi.waitFor(() => {
        flushSync();
        expect(target.querySelector('.entry-dialog [role="alert"]')?.textContent).toBe(
          "名称不能为空",
        );
        if (paletteFailed)
          expect(target.querySelector(".palette-error")?.textContent).toContain("配色读取不可用");
      });
      expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(true);
      click("取消");
      expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
      expect(api.entryRename).not.toHaveBeenCalled();
    },
  );

  it("工具栏删除可以取消，确认框明确显示目标且保持当前文档", async () => {
    await start();
    await requestToolbarTrash("other.md");
    expect(target.querySelector(".entry-dialog")?.textContent).toContain(
      "将“other.md”移到系统废纸篓",
    );
    expect(api.entryTrash).not.toHaveBeenCalled();
    click("取消");
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    expect(disk.has("other.md")).toBe(true);
    expect(target.querySelector(".document-name")?.textContent).toBe("note.md");
  });

  it("文件管理删除文件夹先保存其中的笔记，清除整棵子树并交还焦点", async () => {
    disk.set("项目/子目录/草稿.md", encode("draft\n"));
    await start();
    openDocument("项目/子目录/草稿.md");
    await vi.waitFor(() => expect(target.querySelector(".ProseMirror")?.textContent).toBe("draft"));
    target.querySelector<HTMLElement>(".ProseMirror")!.blur();
    await edit("saved before folder trash");
    vi.mocked(api.entryTrash).mockImplementation(async (path) => {
      expect(path).toBe("项目");
      expect(decode(disk.get("项目/子目录/草稿.md")!)).toBe("saved before folder trash\n");
      for (const item of disk.keys()) if (item.startsWith(`${path}/`)) disk.delete(item);
      return { warning: null };
    });
    await requestToolbarTrash("项目");
    expect(target.querySelector(".entry-dialog")?.textContent).toContain(
      "其中的所有文件会一起移动",
    );
    click("移到废纸篓");
    await vi.waitFor(() => {
      expect(target.querySelector('.library [data-path="项目"]')).toBeNull();
      expect(target.querySelector(".ProseMirror")).toBeNull();
      expect(document.activeElement?.closest('.library [role="gridcell"][aria-selected="true"]')).not.toBeNull();
    });
    expect(api.entryTrash).toHaveBeenCalledExactlyOnceWith("项目");
    expect(disk.has("note.md")).toBe(true);
  });

  it.each([
    { source: "资料管理", trash: beginTrash },
    { source: "文件管理工具栏", trash: beginToolbarTrash },
  ])("删除当前笔记先保存最新编辑，成功后清空当前文档和会话（$source）", async ({ trash }) => {
    await start();
    await edit("before trash");
    vi.mocked(api.entryTrash).mockImplementation(async (path) => {
      expect(decode(disk.get(path)!)).toBe("before trash\n");
      disk.delete(path);
      return { warning: null };
    });
    await trash("note.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")).toBeNull();
      expect(target.querySelector('[data-path="note.md"]')).toBeNull();
    });
    expect(api.entryTrash).toHaveBeenCalledOnce();
    expect(api.sessionSetDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panes: [expect.objectContaining({ currentPath: null })],
      }),
    );
    expect(disk.has("other.md")).toBe(true);
  });

  it("当前编辑有保存冲突时无法进入文件管理删除，新建也保留原编辑", async () => {
    await start();
    vi.mocked(api.fileWrite).mockResolvedValue({
      status: "conflict",
      disk: encode("external\n"),
    });
    await edit("my unsaved work");
    onCommand("open-library");
    await vi.waitFor(() => {
      flushSync();
      expect(status()).toBe("存在保存冲突");
    });
    expect(target.querySelector<HTMLElement>(".library")!.hidden).toBe(true);
    expect(api.entryTrash).not.toHaveBeenCalled();
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    onCommand("new-note");
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".message")?.textContent).toContain("当前编辑尚未保存");
    });
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    expect(api.entryCreate).not.toHaveBeenCalled();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("my unsaved work");
    expect(disk.has("note.md")).toBe(true);
  });

  it("重命名前保存失败时保留已输入名称，恢复后可在原对话框重试", async () => {
    await start();
    await edit("keep before rename");
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("磁盘暂不可写"));
    vi.mocked(api.entryRename).mockImplementation(async (from, to) => {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      return { warning: null };
    });
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('.entry-dialog [role="alert"]')?.textContent).toBe(
        "当前编辑尚未保存，请先处理保存问题后重试。",
      );
    });
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(true);
    expect(target.querySelector<HTMLInputElement>("#entry-name")?.value).toBe("renamed.md");
    expect(api.entryRename).not.toHaveBeenCalled();
    expect(decode(disk.get("note.md")!)).toBe("base\n");
    click("重命名");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    });
    expect(api.entryRename).toHaveBeenCalledExactlyOnceWith("note.md", "renamed.md");
    expect(decode(disk.get("renamed.md")!)).toBe("keep before rename\n");
    expect(target.querySelector(".document-name")?.textContent).toBe("renamed.md");
  });

  it("选择草稿补出的缺失目录后，新建不能悄悄改到笔记库根目录", async () => {
    disk.set("失踪/草稿.md", encode("recovered\n"));
    vi.mocked(api.entryCreate).mockRejectedValue(new Error("父文件夹不存在"));
    await start();
    target.querySelector<HTMLButtonElement>('.library [data-path="失踪"]')!.click();
    flushSync();
    target.querySelector<HTMLButtonElement>(".library-heading .primary")!.click();
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".feedback-announcement")?.textContent).toContain(
        "父文件夹不存在",
      );
    });
    expect(api.entryCreate).toHaveBeenCalledExactlyOnceWith("失踪/未命名.md", "file", undefined);
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
  });

  it("被真实目录结构阻挡的草稿有独立入口，打开并另存后移除恢复提示", async () => {
    disk.set("归档", encode("真实文件\n"));
    disk.set("替换.md/child.md", encode("目录中的文件\n"));
    const recoveries = new Set(["归档/草稿.md", "替换.md"]);
    vi.mocked(api.vaultEntries).mockImplementation(async () => [
      ...[...disk.keys()].map((path) => ({ path, kind: "file" as const })),
      { path: "替换.md", kind: "directory" },
      ...[...recoveries].map((path) => ({
        path,
        kind: "file" as const,
        recoveryOnly: true as const,
      })),
    ]);
    vi.mocked(api.fileSnapshot).mockImplementation(async (path) =>
      recoveries.has(path)
        ? {
            disk: null,
            diskError: "原路径被其他条目占用",
            draft: { bytes: encode("待恢复内容\n"), base: encode("base\n") },
          }
        : { disk: disk.get(path) ?? null, draft: null },
    );
    vi.mocked(api.fileWriteCopy).mockImplementation(async (original, bytes) => {
      const path = `${original.split("/").at(-1)} (副本).md`;
      disk.set(path, bytes);
      recoveries.delete(original);
      return { path, warning: "原文件夹不可用，副本已保存到笔记库根目录。" };
    });
    await start();
    expect(target.querySelector('[aria-label="待恢复的笔记"]')).not.toBeNull();
    expect(
      target.querySelector('.library [data-path="归档"]')?.getAttribute("aria-expanded"),
    ).toBeNull();
    expect(
      target.querySelector('.library [data-path="替换.md"]')?.getAttribute("aria-expanded"),
    ).toBeNull();
    for (const path of [...recoveries]) {
      target.querySelector<HTMLButtonElement>(`.recovery-entry[data-path="${path}"]`)!.click();
      await vi.waitFor(() => {
        flushSync();
        expect(target.querySelector(".ProseMirror")?.textContent).toBe("待恢复内容");
        expect(target.querySelector(".save-notice")?.textContent).toContain("原文件暂时无法读取");
      });
      expect(target.querySelector(".save-notice")?.textContent).toContain("原路径被其他条目占用");
      expect(target.querySelector('.library [role="grid"]')).not.toBeNull();
      expect(target.querySelectorAll('.library [role="grid"] [aria-current="page"]')).toHaveLength(0);
      click("另存为副本");
      await vi.waitFor(() => expect(status()).toBe("已保存"));
      expect(target.querySelector(`.recovery-entry[data-path="${path}"]`)).toBeNull();
    }
    expect(target.querySelector('[aria-label="待恢复的笔记"]')).toBeNull();
    expect(decode(disk.get("归档")!)).toBe("真实文件\n");
    expect(decode(disk.get("替换.md/child.md")!)).toBe("目录中的文件\n");
  });

  it.each(
    [
      { source: "资料管理", trash: beginTrash },
      { source: "文件管理工具栏", trash: beginToolbarTrash },
    ].flatMap((entry) => [false, true].map((paletteFailed) => ({ ...entry, paletteFailed }))),
  )(
    "系统废纸篓失败时保留文件、当前选择和可重试的对话框（$source，配色读取失败：$paletteFailed）",
    async ({ trash, paletteFailed }) => {
      if (paletteFailed)
        vi.mocked(appApi.readingPaletteGet).mockRejectedValueOnce(new Error("配色读取不可用"));
      await start();
      vi.mocked(api.entryTrash).mockRejectedValue(new Error("废纸篓不可用"));
      await trash("note.md");
      await vi.waitFor(() => {
        flushSync();
        expect(target.querySelector('.entry-dialog [role="alert"]')?.textContent).toContain(
          "废纸篓不可用",
        );
        if (paletteFailed)
          expect(target.querySelector(".palette-error")?.textContent).toContain("配色读取不可用");
      });
      expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(true);
      expect(target.querySelector(".file.active")?.getAttribute("data-path")).toBe("note.md");
      expect(disk.has("note.md")).toBe(true);
      click("取消");
      click("← 返回文档");
      await vi.waitFor(() => expect(target.querySelector<HTMLElement>(".library")!.hidden).toBe(true));
      await edit("still editable");
      click("保存");
      await vi.waitFor(() => expect(status()).toBe("已保存"));
      expect(decode(disk.get("note.md")!)).toBe("still editable\n");
    },
  );

  it("二进制附件不能进入文本编辑器，切换和关闭也不会写回附件", async () => {
    const binary = new Uint8Array([80, 75, 3, 4, 0, 255]);
    disk.set("archive.zip", binary);
    await start();
    openDocument("archive.zip");
    await vi.waitFor(() => {
      flushSync();
      expect(
        target.querySelector(".document-name")?.getAttribute("title"),
      ).toBe("archive.zip");
    });
    expect(target.querySelector(".cm-editor")).toBeNull();
    expect(target.textContent).toContain("暂不支持预览此文件");
    click("保存");
    onClose();
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalled());
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(disk.get("archive.zip")).toEqual(binary);
  });

  it("旧版本误建的附件文本草稿不能覆盖原二进制文件", async () => {
    const binary = new Uint8Array([80, 75, 3, 4, 0, 255]);
    disk.set("archive.zip", binary);
    await start();
    vi.mocked(api.fileSnapshot).mockResolvedValueOnce({
      disk: binary,
      draft: { bytes: encode("mistaken text edit"), base: binary },
    });
    openDocument("archive.zip");
    await vi.waitFor(() => expect(status()).toBe("只读预览"));
    expect(target.querySelector(".cm-editor")).toBeNull();
    openDocument("other.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(disk.get("archive.zip")).toEqual(binary);
  });

  it("外部将文本替换为二进制后，刷新会退出编辑器并禁用保存", async () => {
    await start();
    disk.set("note.md", new Uint8Array([0, 255]));
    onChanged();
    await vi.waitFor(() => expect(status()).toBe("只读预览"));
    expect(target.querySelector(".ProseMirror")).toBeNull();
    expect(target.textContent).toContain("暂不支持预览此文件");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("外部文件变为二进制时，仍恢复原本有效的文本草稿并保留冲突", async () => {
    const binary = new Uint8Array([0, 255]);
    vi.mocked(api.fileSnapshot).mockResolvedValue({
      disk: binary,
      draft: { bytes: encode("recovered text\n"), base: encode("base\n") },
    });
    await start();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("recovered text");
    expect(status()).toBe("存在保存冲突");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("重命名提交后的索引警告保留新路径，并明确说明文件已经改名", async () => {
    await start();
    vi.mocked(api.entryRename).mockImplementation(async (from, to) => {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      return { warning: "链接索引更新失败" };
    });
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(
        target.querySelector(".document-name")?.getAttribute("title"),
      ).toBe("renamed.md");
      expect(target.textContent).toContain("操作已完成。链接索引更新失败");
    });
    expect(api.sessionSetDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panes: [expect.objectContaining({ currentPath: "renamed.md" })],
      }),
    );
    expect(api.indexMentionsTo).toHaveBeenLastCalledWith("renamed.md");
    expect(status()).toBe("已保存");
  });

  it("重命名失败后保持原文件可编辑", async () => {
    await start();
    vi.mocked(api.entryRename).mockRejectedValue(new Error("写入失败，已恢复原文件"));
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("重命名或移动失败：写入失败，已恢复原文件");
    });
    expect(target.querySelector(".document-name")?.getAttribute("title")).toBe(
      "note.md",
    );
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(true);
    click("取消");
    await edit("after failure");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(decode(disk.get("note.md")!)).toBe("after failure\n");
  });

  it("改名已提交但读回失败时，提示真实结果并允许从新路径重新打开", async () => {
    await start();
    vi.mocked(api.entryRename).mockImplementation(async (from, to) => {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      return { warning: null };
    });
    vi.mocked(api.fileSnapshot).mockRejectedValueOnce(new Error("读取失败"));
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain(
        "重命名或移动已完成，当前路径 renamed.md，但界面更新失败",
      );
      expect(target.querySelector(".ProseMirror")).toBeNull();
    });
    openDocument("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    });
    expect(api.sessionSetDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panes: [expect.objectContaining({ currentPath: "renamed.md" })],
      }),
    );
  });

  it("外部恢复成最初内容时，编辑器也必须重载，不能只更新保存基准", async () => {
    await start();
    await edit("saved edit");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    disk.set("note.md", encode("base\n"));
    onChanged();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    });
  });

  it("保存期间到达的监视事件会在提交后重新读取", async () => {
    await start();
    await edit("saved edit");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("正在保存…"));
    disk.set("note.md", encode("external after save\n"));
    onChanged();
    pending.resolve({ status: "saved", warning: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("external after save");
    });
  });

  it("携带原始版本保存，冲突后保留编辑并阻止切换和关闭", async () => {
    await start();
    await edit("my edits");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("external\n") });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    expect(api.fileWrite).toHaveBeenCalledWith("note.md", encode("my edits\n"), encode("base\n"));
    expect(target.querySelector(".save-notice pre")?.textContent).toBe("external\n");
    openDocument("other.md");
    onClose();
    await vi.waitFor(() => expect(appApi.closeBlocked).toHaveBeenCalled());
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("my edits");
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
  });

  it("写入失败仍可继续输入，重试使用最新内容", async () => {
    await start();
    await edit("first");
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("磁盘空间不足"));
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("保存失败"));
    await edit("latest");
    click("重试保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(decode(disk.get("note.md")!)).toBe("latest\n");
  });

  it("冲突对比显示快照版本，继续输入后明确提示刷新", async () => {
    await start();
    await edit("对比时的编辑");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("external\n") });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const details = target.querySelector<HTMLDetailsElement>(".save-notice details");
    if (details === null) throw new Error("缺少冲突对比入口");
    details.open = true;
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="编辑快照"] pre')?.textContent).toBe(
        "对比时的编辑\n",
      );
    });
    await edit("继续输入的新内容");
    expect(target.querySelector(".comparison-stale")?.textContent).toContain("编辑已变化");
    click("刷新对比");
    expect(target.querySelector('[aria-label="编辑快照"] pre')?.textContent).toBe(
      "继续输入的新内容\n",
    );
    expect(target.querySelector(".comparison-stale")).toBeNull();
  });

  it("保存冲突同时阻止切库和重命名，所有离开文档的操作共用保存门禁", async () => {
    await start();
    await edit("keep my edits");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("external") });
    click("打开笔记库…");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('.entry-dialog [role="alert"]')?.textContent).toBe(
        "当前编辑尚未保存，请先处理保存问题后重试。",
      );
    });
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(true);
    expect(api.vaultOpen).not.toHaveBeenCalled();
    expect(api.entryRename).not.toHaveBeenCalled();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("keep my edits");
  });

  it("切换等待保存时拒绝重复切换，关闭请求等待完整操作后自动继续", async () => {
    await start();
    await edit("before switching");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    openDocument("other.md");
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledTimes(1));
    onCommand("open-vault");
    onClose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(api.vaultOpen).not.toHaveBeenCalled();
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
    pending.resolve({ status: "saved", warning: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    expect(api.fileWrite).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalledTimes(1));
  });

  it("启动恢复尚未完成时记住关闭请求，完成后自动关闭", async () => {
    const restored = deferred<VaultRestore>();
    vi.mocked(api.vaultRestore).mockReturnValueOnce(restored.promise);
    const started = start();
    await vi.waitFor(() => expect(api.vaultRestore).toHaveBeenCalledTimes(1));
    onClose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
    restored.resolve({
      root: "/notes",
      entries: await api.vaultEntries(),
      documents: {
        panes: [{ currentPath: "note.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: [],
      fileTree: null,
    });
    await started;
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalledTimes(1));
  });

  it("等待中的关闭请求遇到保存冲突时保留窗口和编辑", async () => {
    await start();
    await edit("keep while closing");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValue(pending.promise);
    openDocument("other.md");
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledTimes(1));
    onClose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
    pending.resolve({ status: "conflict", disk: encode("external\n") });
    await vi.waitFor(() => expect(appApi.closeBlocked).toHaveBeenCalledTimes(1));
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("keep while closing");
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
  });

  it("关闭请求等待副本提交，并保存等待期间继续输入的最新内容", async () => {
    await start();
    await edit("copy me");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external\n"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    click("另存为副本");
    await vi.waitFor(() => expect(api.fileWriteCopy).toHaveBeenCalledTimes(1));
    onClose();
    await edit("latest while copying");
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
    disk.set("note (副本).md", encode("copy me\n"));
    pending.resolve({ path: "note (副本).md", warning: null });
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalledTimes(1));
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note (副本).md",
      encode("latest while copying\n"),
      encode("copy me\n"),
    );
  });

  it("副本已写入但会话保存失败时，保留新路径并报告真实提交结果", async () => {
    await start();
    await edit("copied edits");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    vi.mocked(api.sessionSetDocuments).mockRejectedValueOnce(new Error("会话不可写"));
    click("另存为副本");
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("副本已保存为 note (副本).md，但工作区状态未能更新");
    });
    expect(target.querySelector(".message details")?.textContent).toContain("会话不可写");
    expect(target.querySelector(".feedback-announcement")?.textContent).not.toContain("会话不可写");
    expect(target.querySelector(".document-name")?.textContent).toBe("note (副本).md");
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("copied edits");
    expect(status()).toBe("已保存");
    expect(decode(disk.get("note.md")!)).toBe("base\n");
    expect(decode(disk.get("note (副本).md")!)).toBe("copied edits\n");
    expect(target.querySelector(".feedback-announcement")?.getAttribute("role")).toBe("alert");
    await edit("continued after warning");
    expect(target.querySelector(".message")?.textContent).toContain("会话不可写");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.querySelector(".message")?.textContent).toContain("会话不可写");
  });

  it("布局失败说明影响并折叠技术详情，正文保存不能代替用户确认该错误", async () => {
    await start();
    vi.mocked(api.sessionSetPanes).mockRejectedValueOnce(new Error("EACCES: session.json"));
    const toggle = target.querySelector('[aria-label="显示或隐藏文件栏"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("缺少文件栏开关");
    toggle.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".feedback-announcement")?.textContent).toContain(
        "下次打开可能恢复为原布局",
      );
    });
    expect(target.querySelector(".feedback-announcement")?.textContent).not.toContain("EACCES");
    const detail = target.querySelector(".message details");
    expect(detail?.hasAttribute("open")).toBe(false);
    expect(detail?.textContent).toContain("EACCES: session.json");
    await edit("saved after layout failure");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.querySelector(".message")?.textContent).toContain("文件栏布局未能保存");
    click("知道了");
    expect(target.querySelector(".message")).toBeNull();
  });

  it("副本成功消息只对应已提交版本，继续编辑后消失而失败原因继续保留", async () => {
    await start();
    await edit("first copy");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    click("另存为副本");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".message")?.textContent).toContain("副本已保存为");
    });
    await edit("next revision");
    expect(target.querySelector(".message")).toBeNull();
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("磁盘空间不足"));
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("保存失败"));
    await edit("keep editing");
    expect(target.querySelector(".save-error")?.textContent).toContain("磁盘空间不足");
    expect(target.querySelector(".message")).toBeNull();
  });

  it("副本提交期间的新输入仍未保存，成功消息明确这一区别", async () => {
    await start();
    await edit("copy snapshot");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    click("另存为副本");
    await vi.waitFor(() => expect(api.fileWriteCopy).toHaveBeenCalledOnce());
    await edit("newer edits");
    disk.set("note (副本).md", encode("copy snapshot\n"));
    pending.resolve({ path: "note (副本).md", warning: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".message")?.textContent).toContain("后续编辑尚未保存");
    });
    expect(status()).toBe("未保存");
    expect(disk.get("note (副本).md")).toEqual(encode("copy snapshot\n"));
  });

  it("在保存期间输入的内容保持未保存，后续写入使用已提交的基准", async () => {
    await start();
    await edit("first");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("正在保存…"));
    await edit("second");
    pending.resolve({ status: "saved", warning: null });
    await vi.waitFor(() => expect(status()).toBe("未保存"));
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("second");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note.md",
      encode("second\n"),
      encode("first\n"),
    );
  });

  it("已提交内容的索引警告不会把文件标成未保存或阻止关闭", async () => {
    await start();
    await edit("saved content");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "saved", warning: "链接索引更新失败" });
    vi.mocked(api.indexMentionsTo).mockRejectedValue(new Error("提及查询失败"));
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.textContent).toContain("内容已保存。链接索引更新失败");
    onClose();
    await vi.waitFor(() => expect(appApi.closeAfterFlush).toHaveBeenCalled());
    expect(appApi.closeBlocked).not.toHaveBeenCalled();
  });

  it("后续保存恢复正常时清理上次保存产生的索引警告", async () => {
    await start();
    await edit("first commit");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "saved",
      warning: "链接索引更新失败",
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.querySelector(".message")?.textContent).toContain("链接索引更新失败");
    await edit("next commit");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.querySelector(".message")).toBeNull();
  });

  it("另存副本期间继续输入，切换到副本时仍保留最新内容", async () => {
    await start();
    await edit("my edits");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external\n"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    click("另存为副本");
    await vi.waitFor(() => expect(api.fileWriteCopy).toHaveBeenCalledOnce());
    await edit("newer edits");
    pending.resolve({ path: "note (副本).md", warning: null });
    await vi.waitFor(() => expect(status()).toBe("未保存"));
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("newer edits");
    expect(api.sessionSetDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panes: [expect.objectContaining({ currentPath: "note (副本).md" })],
      }),
    );
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note (副本).md",
      encode("newer edits\n"),
      encode("my edits\n"),
    );
  });

  it("副本的引用查询失败时，不能继续显示原笔记的引用", async () => {
    vi.mocked(api.indexMentionsTo).mockResolvedValue({
      linked: [
        {
          fromPath: "source.md",
          fromTitle: "原笔记来源",
          mtime: 1,
          startByte: 0,
          endByte: 4,
          snippet: "仅引用原笔记",
          kind: "linked",
          linkKind: "wiki",
          toRaw: "note",
        },
      ],
      unlinked: [],
    });
    await start();
    expect(target.querySelector(".references")).not.toBeNull();
    await edit("copy content");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external\n"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    vi.mocked(api.indexMentionsTo).mockRejectedValue(new Error("查询暂不可用"));
    click("另存为副本");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.querySelector(".document-name")?.textContent).toBe("note (副本).md");
    expect(target.querySelector(".references")).toBeNull();
  });

  it("重新启动可打开已删除文件的恢复草稿，并提示删除冲突", async () => {
    disk.delete("note.md");
    vi.mocked(api.vaultList).mockResolvedValue(["note.md", "other.md"]);
    vi.mocked(api.fileSnapshot).mockResolvedValue({
      disk: null,
      draft: { bytes: encode("recovered\n"), base: encode("base\n") },
    });
    await start();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("recovered");
    expect(status()).toBe("存在保存冲突");
    expect(target.textContent).toContain("原文件已在其他地方删除");
    expect(target.textContent).toContain("已恢复上次未保存的编辑");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("晚到的文件监视结果不能覆盖新打开的文件", async () => {
    await start();
    const pending = deferred<FileSnapshot>();
    vi.mocked(api.fileSnapshot).mockReturnValueOnce(pending.promise);
    onChanged();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledTimes(2));
    openDocument("other.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    pending.resolve({ disk: encode("stale content\n"), draft: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
  });

  it("切换文档后，即使新提及查询尚未开始，旧查询也不能更新引用", async () => {
    await start();
    const pending = deferred<Mentions>();
    vi.mocked(api.indexMentionsTo).mockReturnValueOnce(pending.promise);
    onChanged();
    await vi.waitFor(() => expect(api.indexMentionsTo).toHaveBeenCalledTimes(2));
    const remembered = deferred<void>();
    vi.mocked(api.sessionSetDocuments).mockReturnValueOnce(remembered.promise);
    openDocument("other.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    pending.resolve({
      linked: [],
      unlinked: [
        {
          fromPath: "source.md",
          fromTitle: "过期来源",
          mtime: 1,
          startByte: 0,
          endByte: 4,
          snippet: "旧文档的过期提及",
          kind: "unlinked",
          linkKind: null,
          toRaw: "note",
        },
      ],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.textContent).not.toContain("旧文档的过期提及");
    remembered.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("section[data-pane]")?.hasAttribute("inert")).toBe(false);
    });
  });
});

describe("后台故障独立于正文保存", () => {
  it("监视失败可见，普通文件操作不会清掉故障，验证恢复后才移除", async () => {
    await start();
    onChanged({ status: "watch-error", paths: [], message: "系统监视资源不足" });
    flushSync();
    expect(target.querySelector(".health-notice")?.textContent).toContain(
      "外部修改可能不会及时出现",
    );
    onChanged({ status: "changed", paths: [], healthy: false });
    flushSync();
    expect(target.querySelector(".health-notice")?.textContent).toContain("系统监视资源不足");
    onChanged({ status: "changed", paths: ["note.md"], healthy: true });
    flushSync();
    expect(target.querySelector(".health-notice")).toBeNull();
  });

  it("线程停止立即告知保存能力受影响，而不是等下一次保存才发现", async () => {
    await start();
    onChanged({ status: "worker-error", paths: [], message: "意外退出" });
    flushSync();
    expect(target.querySelector(".health-notice")?.textContent).toContain("无法继续保存");
    expect(target.querySelector(".ProseMirror")?.textContent).toContain("base");
  });
});

describe("原生菜单与输入法", () => {
  it("菜单撤销与重做使用正文历史，组词期间忽略历史命令", async () => {
    await start();
    expect(appApi.historyChanged).toHaveBeenLastCalledWith({ undo: false, redo: false });
    await edit("菜单输入");
    expect(appApi.historyChanged).toHaveBeenLastCalledWith({ undo: true, redo: false });
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    onCommand("undo");
    flushSync();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("菜单输入");
    expect(appApi.historyChanged).toHaveBeenLastCalledWith({ undo: false, redo: false });
    window.dispatchEvent(new CompositionEvent("compositionend"));
    onCommand("undo");
    flushSync();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    expect(appApi.historyChanged).toHaveBeenLastCalledWith({ undo: false, redo: true });
    onCommand("redo");
    flushSync();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("菜单输入");
    expect(appApi.historyChanged).toHaveBeenLastCalledWith({ undo: true, redo: false });
  });

  it("新建文件夹对话框在组词中不提交、不取消，也不显示保存门禁错误", async () => {
    await start();
    onCommand("new-folder");
    flushSync();
    const dialog = target.querySelector(".entry-dialog");
    const input = target.querySelector("#entry-name");
    if (!(dialog instanceof HTMLDialogElement) || !(input instanceof HTMLInputElement))
      throw new Error("新建对话框未挂载");
    await Promise.resolve();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    click("创建");
    await vi.waitFor(() => {
      flushSync();
      expect(dialog.querySelector('button[type="submit"]:disabled')).toBeNull();
    });
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(api.entryCreate).not.toHaveBeenCalled();
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    click("取消");
    expect(dialog.open).toBe(true);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    click("取消");
    expect(dialog.open).toBe(false);
  });

  it("组词期间暂停自动保存，结束后按停键时间保存最终内容", async () => {
    await start();
    vi.useFakeTimers();
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    const editing = edit("中文输入");
    await vi.advanceTimersByTimeAsync(0);
    await editing;
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.fileWrite).not.toHaveBeenCalled();
    window.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.fileWrite).toHaveBeenCalledWith("note.md", encode("中文输入\n"), encode("base\n"));
  });

  it("连续中文组词超过十秒后在确认时保存，反复组词不能重置期限", async () => {
    await start();
    vi.useFakeTimers();
    for (let second = 0; second < 11; second++) {
      window.dispatchEvent(new CompositionEvent("compositionstart"));
      const editing = edit(`中文输入${second}`);
      await vi.advanceTimersByTimeAsync(0);
      await editing;
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.fileWrite).not.toHaveBeenCalled();
      if (second < 9) window.dispatchEvent(new CompositionEvent("compositionend"));
    }
    window.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fileWrite).toHaveBeenCalledOnce();
    expect(api.fileWrite).toHaveBeenCalledWith("note.md", encode("中文输入10\n"), encode("base\n"));
  });

  it("副本写入完成也等待正在进行的组词，再切换副本并保留最终输入", async () => {
    await start();
    await edit("副本内容");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external\n"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    click("另存为副本");
    await vi.waitFor(() => expect(api.fileWriteCopy).toHaveBeenCalledOnce());
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    const editor = target.querySelector(".ProseMirror");
    pending.resolve({ path: "note (副本).md", warning: null });
    await edit("副本最终输入");
    expect(target.querySelector(".ProseMirror")).toBe(editor);
    expect(api.sessionSetDocuments).not.toHaveBeenCalledWith(
      expect.objectContaining({
        panes: [expect.objectContaining({ currentPath: "note (副本).md" })],
      }),
    );
    window.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() =>
      expect(api.sessionSetDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          panes: [expect.objectContaining({ currentPath: "note (副本).md" })],
        }),
      ),
    );
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("副本最终输入");
    expect(status()).toBe("未保存");
  });

  it("组词期间所有保存和离开入口共用门禁，关闭不会提交候选文字", async () => {
    await start();
    await edit("正在组词");
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    click("保存");
    onCommand("quick-switcher");
    expect(target.querySelector("dialog.picker")).toBeNull();
    onClose();
    await vi.waitFor(() => expect(appApi.closeBlocked).toHaveBeenCalled());
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
    expect(appApi.closeAfterFlush).not.toHaveBeenCalled();
    window.dispatchEvent(new CompositionEvent("compositionend"));
    click("保存");
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledTimes(1));
  });

  it("组词开始前发出的外部读取不能在组词中重建编辑器", async () => {
    await start();
    const editor = target.querySelector(".ProseMirror");
    const pending = deferred<FileSnapshot>();
    vi.mocked(api.fileSnapshot).mockReturnValueOnce(pending.promise);
    onChanged();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    disk.set("note.md", encode("external\n"));
    pending.resolve({ disk: encode("external\n"), draft: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelector(".ProseMirror")).toBe(editor);
    expect(editor?.textContent).toBe("base");
    window.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("external");
    });
  });

  it("查找复用当前文档入口，组词期间忽略菜单的新建和切库", async () => {
    await start();
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    onCommand("open-vault");
    onCommand("new-note");
    expect(api.vaultOpen).not.toHaveBeenCalled();
    expect(target.querySelector("dialog[open]")).toBeNull();
    window.dispatchEvent(new CompositionEvent("compositionend"));
    const formatting = target.querySelector<HTMLElement>("[id^='editor-formatting']");
    if (formatting === null) throw new Error("格式面板未挂载");
    formatting.hidePopover = () => {};
    onCommand("find");
    flushSync();
    expect(target.querySelector('input[role="searchbox"]:focus')).not.toBeNull();
  });
});
