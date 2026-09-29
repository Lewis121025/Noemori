/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@app/App.svelte";
import type {
  AppApi,
  AppCommand,
} from "../../../../../modules/notes/packages/desktop/src/shared/api";
import type { ReaderApi, VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (value: string) => new TextEncoder().encode(value);
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let api: ReaderApi;
let command: (value: AppCommand) => void;
let disk: Map<string, Uint8Array>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) =>
    clearTimeout(handle),
  );
  HTMLElement.prototype.hidePopover = vi.fn();
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  disk = new Map([
    ["note.md", encode("# 当前笔记\n\n继续写作。\n")],
    ["other.md", encode("# 另一份资料\n\n仅供预览。\n")],
  ]);
  api = createReaderApiMock({
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
    vaultList: vi.fn(async () => [...disk.keys()]),
    vaultEntries: vi.fn(async () =>
      [...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
    ),
    fileRead: vi.fn(async (path) => disk.get(path)!),
    fileSnapshot: vi.fn(async (path) => ({ disk: disk.get(path) ?? null, draft: null })),
    fileWrite: vi.fn(async (path, bytes) => {
      disk.set(path, bytes);
      return { status: "saved", warning: null };
    }),
    entryCreate: vi.fn(async (path, _kind, initial) => {
      disk.set(path, initial ?? encode(""));
      return { warning: null };
    }),
  });
  const app: AppApi = {
    historyChanged: vi.fn(),
    appearanceGet: vi.fn(async () => "system"),
    appearanceSet: vi.fn(async () => {}),
    subscribeCommand: (callback) => {
      command = callback;
      return () => {};
    },
    subscribeFlushBeforeClose: () => () => {},
    closeAfterFlush: vi.fn(async () => {}),
    closeBlocked: vi.fn(async () => {}),
  };
  window.nous = { app, reader: api };
});
afterEach(async () => {
  if (component !== undefined) await unmount(component);
  target.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  component = mount(App, { target });
  await vi.waitFor(() => {
    flushSync();
    expect(api.vaultRestore).toHaveBeenCalled();
    expect(target.querySelector<HTMLButtonElement>(".space-button")?.disabled).toBe(false);
    if (disk.has("note.md")) expect(prose()?.textContent).toContain("继续写作");
  });
}
const library = () => target.querySelector<HTMLElement>(".library")!;
const prose = () => target.querySelector<HTMLElement>(".ProseMirror")!;
function click(text: string): void {
  const button = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  button!.click();
  flushSync();
}
async function manage(): Promise<void> {
  command("open-library");
  await vi.waitFor(() => {
    flushSync();
    expect(library().hidden).toBe(false);
  });
}

describe("资料管理与读写空间", () => {
  it("返回读写后立刻卸载工作区，待执行的焦点交接应取消", async () => {
    await start();
    await manage();
    click("返回阅读与写作");
    const removing = unmount(component!);
    component = undefined;
    await removing;
    await Promise.resolve();
    expect(document.activeElement?.isConnected).toBe(true);
  });
  it("通过键盘进入管理前也提交属性输入，不能把仍在输入的值留在隐藏面板", async () => {
    disk.set("note.md", encode("---\nstatus: 旧值\n---\n\n继续写作。\n"));
    await start();
    const input = target.querySelector<HTMLInputElement>('[aria-label="属性 status 的值"]')!;
    input.focus();
    input.value = "新值";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    await manage();
    expect(new TextDecoder().decode(disk.get("note.md"))).toContain("status: 新值");
  });
  it("单击只预览，回到写作保留编辑器与管理选择，双击才打开资料", async () => {
    await start();
    const editor = prose();
    await manage();
    const reads = vi.mocked(api.fileSnapshot).mock.calls.length;
    library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(library().querySelector(".excerpt")?.textContent).toContain("仅供预览");
    });
    expect(api.fileSnapshot).toHaveBeenCalledTimes(reads);
    expect(prose()).toBe(editor);
    click("返回阅读与写作");
    expect(library().hidden).toBe(true);
    expect(prose()).toBe(editor);
    expect(prose().textContent).toContain("继续写作");
    await manage();
    expect(library().querySelector('[data-path="other.md"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    library()
      .querySelector('[data-path="other.md"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(library().hidden).toBe(true);
      expect(prose().textContent).toContain("仅供预览");
    });
  });
  it("离开写作前的保存冲突阻止页面切换，原编辑仍可处理", async () => {
    await start();
    prose().querySelector("p")!.textContent = "没有保存的想法";
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("外部修改") });
    command("open-library");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".save-notice")?.textContent).toContain("原文件已在其他地方修改");
    });
    expect(library().hidden).toBe(true);
    expect(prose().textContent).toContain("没有保存的想法");
    expect(api.sessionSetPanes).not.toHaveBeenCalledWith(
      expect.objectContaining({ space: "library" }),
    );
  });
  it("多选时预览解释批量整理状态，不再要求重新选择一份资料", async () => {
    await start();
    await manage();
    const first = library().querySelector<HTMLButtonElement>('[data-path="note.md"]')!;
    first.click();
    library()
      .querySelector<HTMLButtonElement>('[data-path="other.md"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    flushSync();
    const preview = library().querySelector(".library-preview")!;
    expect(preview.textContent).toContain("已选择 2 项资料");
    expect(preview.textContent).not.toContain("选一份资料");
  });
  it("窄窗口预览用 Escape 返回原选中行，输入法拥有的 Escape 不关闭预览", async () => {
    vi.stubGlobal("innerWidth", 640);
    await start();
    await manage();
    const row = library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!;
    row.click();
    flushSync();
    click("预览");
    const preview = library().querySelector<HTMLElement>(".library-preview")!;
    const open = preview.querySelector<HTMLButtonElement>("button")!;
    open.focus();
    open.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    flushSync();
    expect(library().querySelector(".library-list")?.getAttribute("aria-hidden")).toBe("true");
    open.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(library().querySelector(".library-list")?.getAttribute("aria-hidden")).toBe("false");
      expect(document.activeElement).toBe(row);
    });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
  it("迟到的预览不能覆盖新选择，读取失败只影响预览", async () => {
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(api.fileRead).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await start();
    await manage();
    await vi.waitFor(() => expect(api.fileRead).toHaveBeenCalled());
    library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(library().querySelector(".excerpt")?.textContent).toContain("仅供预览");
    });
    finish(encode("迟到的旧预览"));
    await Promise.resolve();
    flushSync();
    expect(library().textContent).not.toContain("迟到的旧预览");
    vi.mocked(api.fileRead).mockRejectedValueOnce(new Error("读取失败"));
    library().querySelector<HTMLButtonElement>('[data-path="note.md"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(library().querySelector('[role="alert"]')?.textContent).toContain("读取失败");
    });
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(prose().textContent).toContain("继续写作");
  });
  it("恢复资料管理页面与查询，输入后自动搜索，不必再按回车", async () => {
    vi.mocked(api.sessionGetPanes).mockResolvedValue({
      filesCollapsed: false,
      leftWidth: 232,
      space: "library",
    });
    await start();
    expect(library().hidden).toBe(false);
    const input = library().querySelector<HTMLInputElement>('input[role="searchbox"]')!;
    input.value = "设计";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(api.sessionSetFileTree).toHaveBeenCalledWith(
        "/notes",
        expect.objectContaining({ browse: { query: "设计", section: "files" } }),
      ),
    );
    click("返回阅读与写作");
    await vi.waitFor(() =>
      expect(api.sessionSetPanes).toHaveBeenCalledWith(
        expect.objectContaining({ space: "writing" }),
      ),
    );
  });
  it("首次开始记录使用本地默认资料夹，已有库新建时跳过命名对话框", async () => {
    vi.mocked(api.vaultRestore).mockResolvedValue(null);
    disk.clear();
    await start();
    click("开始记录");
    await vi.waitFor(() => {
      flushSync();
      expect(prose()).not.toBeNull();
    });
    expect(api.vaultCreateDefault).toHaveBeenCalledOnce();
    expect(api.entryCreate).toHaveBeenCalledWith("未命名.md", "file", undefined);
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
    command("new-note");
    await vi.waitFor(() =>
      expect(api.entryCreate).toHaveBeenCalledWith("未命名 2.md", "file", undefined),
    );
    expect(api.vaultCreateDefault).toHaveBeenCalledOnce();
  });

  it.each(["writing", "library"])("%s 顶部直接新建白板并打开空画布", async (space) => {
    await start();
    if (space === "library") await manage();
    const button = [...target.querySelectorAll<HTMLButtonElement>(".toolbar button")].find(
      (item) => item.textContent?.trim() === "新建白板",
    );
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    button!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".whiteboard")).not.toBeNull();
      expect(library().hidden).toBe(true);
    });
    const created = disk.get("白板.nousboard");
    expect(created).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(created))).toEqual({ version: 1, strokes: [] });
  });
});
