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
import { createAppApiMock } from "../../fixtures/app-api-mock";

const encode = (value: string) => new TextEncoder().encode(value);
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let api: ReaderApi;
let command: (value: AppCommand) => void;
let disk: Map<string, Uint8Array>;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
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
    fileWrite: vi.fn<ReaderApi["fileWrite"]>(async (path, bytes) => {
      disk.set(path, bytes);
      return { status: "saved", warning: null };
    }),
    entryCreate: vi.fn(async (path, _kind, initial) => {
      disk.set(path, initial ?? encode(""));
      return { warning: null };
    }),
  });
  const app: AppApi = createAppApiMock({
    subscribeCommand: (callback) => {
      command = callback;
      return () => {};
    },
  });
  window.noemori = { app, reader: api };
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
    expect(
      target.querySelector<HTMLButtonElement>('.window-toolbar [aria-label="显示或隐藏文件栏"]')
        ?.disabled,
    ).toBe(false);
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

async function createBoard(): Promise<void> {
  command("new-whiteboard");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".whiteboard")).not.toBeNull();
    expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
  });
}

describe("资料管理与读写空间", () => {
  it("连续用键盘调整侧栏宽度只提交最终布局", async () => {
    await start();
    vi.useFakeTimers();
    vi.mocked(api.sessionSetPanes).mockClear();
    try {
      const handle = target.querySelector<HTMLElement>(
        '[role="separator"][aria-label="调整侧栏宽度"]',
      )!;
      for (let index = 0; index < 12; index++) {
        handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        flushSync();
      }
      await vi.advanceTimersByTimeAsync(299);
      expect(api.sessionSetPanes).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.sessionSetPanes).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.sessionSetPanes).mock.calls[0]?.[0].leftWidth).toBe(
        Number(handle.getAttribute("aria-valuenow")),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("文件系统保留白板文档，返回时不读取另一篇笔记", async () => {
    await start();
    await createBoard();
    const board = target.querySelector(".whiteboard");
    command("open-library");
    await vi.waitFor(() => {
      flushSync();
      expect(library().hidden).toBe(false);
    });
    vi.mocked(api.fileSnapshot).mockClear();
    click("← 返回文档");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
    });
    expect(target.querySelector(".whiteboard")).toBe(board);
    expect(api.fileSnapshot).not.toHaveBeenCalled();
  });

  it("在另一栏打开先选择文件，取消不创建空栏", async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    await start();
    command("toggle-split");
    flushSync();
    const picker = target.querySelector("dialog.picker")!;
    picker.dispatchEvent(new Event("cancel", { cancelable: true }));
    flushSync();
    expect(target.querySelectorAll(".pane-column")).toHaveLength(1);
    expect(prose().textContent).toContain("继续写作");
  });

  it("工作台搜索保留原文档，切换浏览页面不重置查询", async () => {
    await start();
    const editor = prose();
    command("find-files");
    flushSync();
    const input = target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]')!;
    input.value = "设计";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalled());
    expect(prose()).toBe(editor);
    await manage();
    expect(input.value).toBe("设计");
    click("← 返回文档");
    await vi.waitFor(() => expect(library().hidden).toBe(true));
    expect(input.value).toBe("设计");
    expect(prose()).toBe(editor);
  });

  it("文件管理页仍能打开侧栏全文搜索，查询聚焦且不切走当前网格", async () => {
    await start();
    await manage();
    command("find-files");
    await vi.waitFor(() => {
      flushSync();
      const input = target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]')!;
      expect(target.querySelector<HTMLElement>(".quick-navigation")!.hidden).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(library().hidden).toBe(false);
    });
  });

  it("浏览入口位于左栏，切换文件系统不卸载当前编辑器", async () => {
    await start();
    const editor = prose();
    expect(target.querySelector(".spaces")).toBeNull();
    command("open-library");
    await vi.waitFor(() => {
      flushSync();
      expect(library().hidden).toBe(false);
    });
    expect(prose()).toBe(editor);
    click("← 返回文档");
    await vi.waitFor(() =>
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false"),
    );
    expect(prose()).toBe(editor);
  });

  it("文件系统也遵守保存门禁，冲突时不隐藏待处理的正文", async () => {
    await start();
    prose().querySelector("p")!.textContent = "不能丢失的编辑";
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("外部修改") });
    command("open-library");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".save-notice")?.textContent).toContain("原文件已在其他地方修改");
    });
    expect(library().hidden).toBe(true);
    expect(prose().textContent).toContain("不能丢失的编辑");
  });

  it("旧关联会话迁移到文件系统，创建白板后进入文档", async () => {
    vi.mocked(api.sessionGetPanes).mockResolvedValue({
      filesCollapsed: false,
      leftWidth: 232,
      space: "connections",
    });
    await start();
    expect(library().querySelector("h1")?.textContent).toBe("文件系统");
    await createBoard();
    expect(library().hidden).toBe(true);
    expect(library().hidden).toBe(true);
  });

  it("新版目的地与搜索偏好优先恢复，不依赖活动文档类型", async () => {
    vi.mocked(api.sessionGetPanes).mockResolvedValue({
      filesCollapsed: false,
      leftWidth: 250,
      space: "connections",
      destination: "library",
      sidebarView: "search",
      searchQuery: "工作台",
    });
    await start();
    expect(library().hidden).toBe(false);
    expect(target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]')?.value).toBe(
      "工作台",
    );
    await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalled());
  });

  it("返回读写后立刻卸载工作区，待执行的焦点交接应取消", async () => {
    await start();
    await manage();
    vi.mocked(api.sessionSetPanes).mockClear();
    vi.mocked(api.sessionSetDocuments).mockClear();
    click("← 返回文档");
    const removing = unmount(component!);
    component = undefined;
    await removing;
    await Promise.resolve();
    expect(document.activeElement?.isConnected).toBe(true);
    expect(api.sessionSetPanes).not.toHaveBeenCalled();
    expect(api.sessionSetDocuments).not.toHaveBeenCalled();
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
    click("← 返回文档");
    await vi.waitFor(() => {
      flushSync();
      expect(library().hidden).toBe(true);
    });
    expect(prose()).toBe(editor);
    expect(prose().textContent).toContain("继续写作");
    await manage();
    expect(
      library()
        .querySelector('[data-path="other.md"]')
        ?.closest('[role="gridcell"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
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
      expect.objectContaining({ destination: "library" }),
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
    expect(row.closest('[role="gridcell"]')?.getAttribute("aria-selected")).toBe("true");
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
  it("资料管理的名称过滤不会覆盖工作台全文查询", async () => {
    await start();
    command("find-files");
    flushSync();
    const search = target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]')!;
    search.value = "设计";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalled());
    await manage();
    vi.mocked(api.searchQuery).mockClear();
    const filter = library().querySelector<HTMLInputElement>('[aria-label="筛选当前列表"]')!;
    filter.value = "other";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(library().querySelector('[data-path="other.md"]')).not.toBeNull();
    expect(search.value).toBe("设计");
    expect(api.searchQuery).not.toHaveBeenCalled();
  });
  it("资料管理的新建入口也直接创建并进入文档，不打开另一套命名流程", async () => {
    await start();
    await manage();
    library().querySelector<HTMLButtonElement>(".library-heading .primary")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(api.entryCreate).toHaveBeenCalledWith("未命名.md", "file", undefined);
    });
    await vi.waitFor(() => expect(library().hidden).toBe(true));
    expect(target.querySelector<HTMLDialogElement>(".entry-dialog")?.open).toBe(false);
  });

  it("首次开始记录使用本地默认资料夹，已有库新建时跳过命名对话框", async () => {
    vi.mocked(api.vaultRestore).mockResolvedValue(null);
    disk.clear();
    await start();
    expect(target.querySelectorAll('button[aria-label="开始记录"]')).toHaveLength(1);
    expect(target.querySelector(".welcome-actions")).toBeNull();
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

  it.each(["writing", "library"])("%s 可通过命令新建白板并进入关联画布", async (space) => {
    await start();
    if (space === "library") await manage();
    command("new-whiteboard");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".whiteboard")).not.toBeNull();
      expect(library().hidden).toBe(true);
    });
    const created = disk.get("白板.noemoriboard");
    expect(created).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(created))).toEqual({ version: 1, strokes: [] });
  });
});

it.each(["open-library"] as const)("窄窗口打开 %s 后收起抽屉，让目标页面可操作", async (action) => {
  vi.stubGlobal("innerWidth", 640);
  await start();
  command(action);
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".files-scrim")?.hasAttribute("hidden")).toBe(true);
    expect(target.querySelector(".content-space")?.hasAttribute("inert")).toBe(false);
  });
});

it("沉浸阅读把文档操作与编辑工具放在顶栏，正文只保留内容", async () => {
  await start();
  const sidebar = target.querySelector<HTMLElement>(".file-sidebar")!;
  expect(target.querySelector('[aria-label="切换阅读模式"]')).toBeNull();
  expect(target.querySelector('.window-toolbar [aria-label="笔记操作"]')).not.toBeNull();
  expect(target.querySelector(".pane-column .document-bar")).toBeNull();
  expect(target.querySelector(".pane-column .outline-sidebar")).toBeNull();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('.window-toolbar [aria-label="编辑工具栏"]')).not.toBeNull();
  });
  expect(target.querySelector('.pane-column [role="toolbar"]')).toBeNull();
  command("find");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('.window-toolbar [aria-label="文内查找替换"]')).not.toBeNull();
  });
  expect(target.querySelector(".main .search-panel")).toBeNull();
  command("toggle-files");
  flushSync();
  expect(sidebar.hidden).toBe(true);
  const reopen = target.querySelector<HTMLButtonElement>(
    '.window-toolbar [aria-label="显示或隐藏文件栏"]',
  )!;
  expect(reopen).not.toBeNull();
  reopen.click();
  flushSync();
  expect(sidebar.hidden).toBe(false);
  expect(prose()?.textContent).toContain("继续写作");
});

it("顶部组件栏切换侧栏面板，保留全文查询与正文实例", async () => {
  await start();
  const editor = prose();
  const bar = target.querySelector<HTMLElement>('[aria-label="组件栏"]')!;
  expect(bar).not.toBeNull();
  const select = (name: string) => {
    bar.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click();
    flushSync();
  };
  select("搜索");
  const search = target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]')!;
  search.value = "继续";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  select("目录");
  expect(target.querySelector<HTMLElement>(".quick-navigation")!.hidden).toBe(true);
  expect(target.querySelector<HTMLElement>(".document-tools")!.hidden).toBe(false);
  select("搜索");
  expect(search.value).toBe("继续");
  expect(prose()).toBe(editor);
  expect(target.querySelector(".pane-column [role=toolbar]")).toBeNull();
});

it("窗口按钮各有唯一入口，设置独立打开，不恢复模式与目录标题", async () => {
  await start();
  const sidebar = target.querySelector(".file-sidebar")!;
  const toggle = target.querySelector('[aria-label="显示或隐藏文件栏"]')!;
  expect(sidebar.contains(toggle)).toBe(false);
  expect(target.querySelectorAll('[aria-label="显示或隐藏文件栏"]')).toHaveLength(1);
  expect(target.querySelectorAll('[aria-label="在另一栏打开…"]')).toHaveLength(1);
  expect(target.querySelector(".mode-switch, .caption")).toBeNull();
  const settings = target.querySelector<HTMLDialogElement>(".settings-window")!;
  expect(settings.open).toBe(false);
  command("open-settings");
  flushSync();
  expect(settings.open).toBe(true);
  expect(sidebar.querySelector('[aria-label="阅读字体"]')).toBeNull();
  settings.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click();
  flushSync();
  expect(settings.open).toBe(false);
  expect(prose()?.getAttribute("contenteditable")).toBe("true");
});

it("双链默认在底部折叠，展开后直接显示来源与摘要，不嵌套折叠层", async () => {
  vi.mocked(api.indexMentionsTo).mockResolvedValue({
    linked: [
      {
        fromPath: "other.md",
        fromTitle: "另一份资料",
        mtime: 1,
        startByte: 0,
        endByte: 6,
        snippet: "这里链接到当前笔记",
        kind: "linked",
        linkKind: "wiki",
        toRaw: "note",
      },
    ],
    unlinked: [],
  });
  await start();
  const dock = target.querySelector(".links-dock")!;
  const toggle = dock.querySelector<HTMLButtonElement>('[aria-label="双链"]')!;
  const panel = dock.querySelector<HTMLElement>('[aria-label="双链面板"]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
  toggle.click();
  flushSync();
  expect(panel.hidden).toBe(false);
  expect(panel.querySelector(".group h3")?.textContent).toBe("另一份资料");
  expect(panel.textContent).toContain("这里链接到当前笔记");
  expect(panel.querySelector("details")).toBeNull();
  toggle.click();
  flushSync();
  expect(panel.hidden).toBe(true);
});

it("双链默认选择有内容的类别，目标去重计数，手动选择保留", async () => {
  vi.mocked(api.indexMentionsTo).mockResolvedValue({
    linked: [
      {
        fromPath: "note.md",
        fromTitle: "当前笔记",
        mtime: 1,
        startByte: 60,
        endByte: 70,
        snippet: "指向自己 [[note#本文]]",
        kind: "linked",
        linkKind: "wiki",
        toRaw: "note#本文",
      },
    ],
    unlinked: [],
  });
  vi.mocked(api.indexLinksFrom).mockResolvedValue([
    {
      fromPath: "note.md",
      toRaw: "other#一",
      toPath: "other.md",
      kind: "wiki",
      resolution: "resolved",
      startByte: 1,
      endByte: 10,
    },
    {
      fromPath: "note.md",
      toRaw: "other#二",
      toPath: "other.md",
      kind: "wiki",
      resolution: "resolved",
      startByte: 20,
      endByte: 30,
    },
    {
      fromPath: "note.md",
      toRaw: "#本文",
      toPath: null,
      kind: "md",
      resolution: "self",
      startByte: 40,
      endByte: 50,
    },
    {
      fromPath: "note.md",
      toRaw: "note#本文",
      toPath: "note.md",
      kind: "wiki",
      resolution: "resolved",
      startByte: 60,
      endByte: 70,
    },
  ]);
  await start();
  target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!.click();
  flushSync();
  const outgoing = target.querySelector<HTMLButtonElement>('button[aria-label="出链"]')!;
  expect(outgoing.getAttribute("aria-pressed")).toBe("true");
  expect(outgoing.textContent?.trim()).toBe("1");
  expect(outgoing.title).toContain("当前笔记 → 其他目标");
  const incoming = target.querySelector<HTMLButtonElement>('button[aria-label="入链"]')!;
  expect(incoming.textContent?.trim()).toBe("0");
  expect(incoming.title).toContain("其他笔记 → 当前笔记");
  incoming.click();
  flushSync();
  target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!.click();
  target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!.click();
  flushSync();
  expect(incoming.getAttribute("aria-pressed")).toBe("true");
});

it("双链高度可用键盘调整，受边界限制，折叠后保留并可恢复默认", async () => {
  await start();
  const toggle = target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!;
  toggle.click();
  flushSync();
  const handle = target.querySelector<HTMLElement>(
    '[role="separator"][aria-label="调整双链高度"]',
  )!;
  expect(handle).not.toBeNull();
  const initial = Number(handle.getAttribute("aria-valuenow"));
  const key = (value: string) => {
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    );
    flushSync();
  };
  key("ArrowUp");
  expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(initial);
  const adjusted = handle.getAttribute("aria-valuenow");
  toggle.click();
  flushSync();
  toggle.click();
  flushSync();
  expect(handle.getAttribute("aria-valuenow")).toBe(adjusted);
  key("End");
  expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));
  key("ArrowUp");
  expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));
  key("Home");
  expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemin"));
  handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  flushSync();
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(initial);
});

it("双链拖动向上增高，其他指针不干扰，取消恢复拖动前高度", async () => {
  await start();
  target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!.click();
  flushSync();
  const handle = target.querySelector<HTMLElement>('[aria-label="调整双链高度"]')!;
  expect(handle).not.toBeNull();
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  const initial = Number(handle.getAttribute("aria-valuenow"));
  const pointer = (name: string, y: number, pointerId = 1, button = 0) => {
    handle.dispatchEvent(
      Object.assign(new Event(name, { bubbles: true, cancelable: true }), {
        clientY: y,
        pointerId,
        button,
      }),
    );
    flushSync();
  };
  pointer("pointerdown", 400, 1, 2);
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
  pointer("pointerdown", 400);
  pointer("pointermove", 320, 2);
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(initial);
  pointer("pointermove", 320);
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(initial + 80);
  pointer("pointercancel", 320);
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(initial);
  pointer("pointerdown", 400);
  pointer("pointermove", 350);
  pointer("pointerup", 350);
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(initial + 50);
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
});

it("组件入口按职责收敛，文件系统通过独立组件进入且不并列显示文件树", async () => {
  await start();
  const editor = prose();
  const bar = target.querySelector<HTMLElement>('[aria-label="组件栏"]')!;
  expect(
    [...bar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["目录", "搜索", "文件系统"]);
  expect(target.querySelector('[aria-label="所有组件"]')).toBeNull();
  expect(target.querySelector('[aria-label="全部组件"]')).toBeNull();
  bar.querySelector<HTMLButtonElement>('[aria-label="文件系统"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(library().hidden).toBe(false);
  });
  expect(target.querySelector<HTMLElement>(".document-tools")!.hidden).toBe(true);
  expect(bar.querySelector('[aria-label="文件系统"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(target.querySelectorAll('.file-menu button[role="menuitem"]')).toHaveLength(1);
  library().querySelector<HTMLButtonElement>('[aria-label="书签"]')!.click();
  flushSync();
  expect(library().querySelector('[aria-label="书签"]')!.getAttribute("aria-pressed")).toBe("true");
  bar.querySelector<HTMLButtonElement>('[aria-label="目录"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(library().hidden).toBe(true);
  });
  expect(target.querySelector<HTMLElement>(".document-tools")!.hidden).toBe(false);
  expect(prose()).toBe(editor);
});

it("文件系统的新建白板入口创建后进入文档", async () => {
  await start();
  await manage();
  await vi.waitFor(() => {
    flushSync();
    expect(library().querySelector("h1")?.textContent).toBe("文件系统");
  });
  expect(target.querySelector('[aria-label="关联视图"]')).toBeNull();
  expect(
    [...library().querySelectorAll(".library-heading button")].filter((button) =>
      /新建白板|创建白板/u.test(button.textContent ?? ""),
    ),
  ).toHaveLength(1);
  [...library().querySelectorAll<HTMLButtonElement>(".library-heading button")]
    .find((button) => button.textContent === "新建白板")!
    .click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".whiteboard")).not.toBeNull();
  });
});

it("源码查找只有文档工具入口，双链面板不再提供图谱", async () => {
  HTMLElement.prototype.showPopover = vi.fn();
  await start();
  command("toggle-source");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".cm-editor")).not.toBeNull();
  });
  command("find");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".code-search-host .cm-search")).not.toBeNull();
  });
  expect(
    [...target.querySelectorAll(".code-toolbar button")].map((button) => button.textContent),
  ).toEqual(["撤销", "重做"]);
  expect(target.querySelectorAll('[aria-label="文内查找"]')).toHaveLength(1);
  command("toggle-source");
  await vi.waitFor(() => {
    flushSync();
    expect(prose()).not.toBeNull();
  });
  target.querySelector<HTMLButtonElement>('[aria-label="双链"]')!.click();
  flushSync();
  expect(target.querySelector('[aria-label="关联图谱"]')).toBeNull();
  expect(target.querySelector(".graph-popover")).toBeNull();
  expect(api.indexMentionsTo).toHaveBeenCalledWith("note.md");
  expect(api.indexLinksFrom).toHaveBeenCalledWith("note.md");
});

it("编辑工具常驻窗口顶栏，收起侧栏仍可使用且正文保持原实例", async () => {
  await start();
  const editor = prose();
  const windowBar = target.querySelector<HTMLElement>(".window-toolbar")!;
  await vi.waitFor(() => {
    flushSync();
    expect(windowBar.querySelector('[aria-label="编辑工具栏"]')).not.toBeNull();
  });
  expect(target.querySelector('.file-sidebar [aria-label="编辑工具栏"]')).toBeNull();
  expect(target.querySelector('.component-button[aria-label="编辑工具"]')).toBeNull();
  command("toggle-files");
  flushSync();
  expect(target.querySelector<HTMLElement>(".file-sidebar")!.hidden).toBe(true);
  expect(windowBar.querySelector('[aria-label="文内查找"]')).not.toBeNull();
  command("find");
  await vi.waitFor(() => {
    flushSync();
    expect(windowBar.querySelector('[aria-label="文内查找替换"]')).not.toBeNull();
  });
  expect(target.querySelector<HTMLElement>(".file-sidebar")!.hidden).toBe(true);
  expect(prose()).toBe(editor);
});

it.each(["new-note", "new-whiteboard"] as const)(
  "文件管理选择普通文件后，%s 仍在浏览目录创建",
  async (action) => {
    disk.set("docs/other.md", encode("# 目录内文件\n"));
    await start();
    await manage();
    library()
      .querySelector<HTMLButtonElement>('[data-path="docs"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    flushSync();
    library().querySelector<HTMLButtonElement>('[data-path="docs/other.md"]')!.click();
    flushSync();
    command(action);
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalled());
    expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toMatch(/^docs\//);
  },
);

it.each(["范围多选", "取消文件夹选择", "仅选择文件夹"])(
  "新建位置由当前选择推导，不残留上次单选目录（%s）",
  async (selection) => {
    disk.set("docs/other.md", encode("# 目录内文件\n"));
    vi.mocked(api.vaultEntries).mockImplementation(async () => [
      { path: "docs", kind: "directory" },
      ...[...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
    ]);
    await start();
    await manage();
    library().querySelector<HTMLButtonElement>(".root-label")!.click();
    flushSync();
    const folder = library().querySelector<HTMLButtonElement>('[data-path="docs"]')!;
    if (selection !== "仅选择文件夹") folder.click();
    flushSync();
    const next =
      selection === "范围多选"
        ? library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!
        : folder;
    next.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    flushSync();
    command("new-note");
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalled());
    expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toBe(
      selection === "仅选择文件夹" ? "docs/未命名.md" : "未命名.md",
    );
  },
);

it.each([
  { action: "new-note", label: "新建笔记" },
  { action: "new-whiteboard", label: "新建白板" },
] as const)(
  "选中跨目录搜索结果后，$label 的按钮和命令使用同一创建目录",
  async ({ action, label }) => {
    disk.set("docs/other.md", encode("# 目录内文件\n"));
    await start();
    for (const entry of ["button", "command"] as const) {
      await manage();
      const search = library().querySelector<HTMLInputElement>('[role="searchbox"]')!;
      search.value = "docs/other.md";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      library().querySelector<HTMLButtonElement>('[data-path="docs/other.md"]')!.click();
      flushSync();
      vi.mocked(api.entryCreate).mockClear();
      if (entry === "command") command(action);
      else click(label);
      await vi.waitFor(() => {
        flushSync();
        expect(api.entryCreate).toHaveBeenCalled();
        expect(library().hidden).toBe(true);
      });
      expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toMatch(/^docs\//);
    }
  },
);

it("文件系统默认显示文件夹导航，侧栏与网格双向切换且保留正文", async () => {
  disk.set("docs/guide.md", encode("# 指南\n"));
  disk.set("docs/sub/detail.md", encode("# 细节\n"));
  vi.mocked(api.vaultEntries).mockImplementation(async () => [
    { path: "docs", kind: "directory" },
    { path: "docs/sub", kind: "directory" },
    { path: "empty", kind: "directory" },
    ...[...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
  ]);
  await start();
  const editor = prose();
  await manage();
  const folders = target.querySelector<HTMLElement>('[aria-label="文件夹导航"]');
  expect(folders).not.toBeNull();
  expect(folders!.querySelector('[data-directory="docs"]')).not.toBeNull();
  expect(folders!.textContent).not.toContain("guide.md");
  folders!.querySelector<HTMLButtonElement>('[data-directory="docs"]')!.click();
  flushSync();
  expect(library().querySelector('[data-path="docs/guide.md"]')).not.toBeNull();
  expect(library().querySelector('[data-path="note.md"]')).toBeNull();
  library()
    .querySelector<HTMLButtonElement>('[data-path="docs/sub"]')!
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  flushSync();
  expect(folders!.querySelector('[data-directory="docs/sub"]')?.getAttribute("aria-current")).toBe(
    "location",
  );
  expect(library().querySelector('[data-path="docs/sub/detail.md"]')).not.toBeNull();
  const search = library().querySelector<HTMLInputElement>('[role="searchbox"]')!;
  search.value = "note";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  folders!.querySelector<HTMLButtonElement>('[data-directory="empty"]')!.click();
  flushSync();
  expect(search.value).toBe("");
  expect(library().querySelectorAll('[role="gridcell"]')).toHaveLength(0);
  expect(library().textContent).toContain("这里还很安静");
  expect(prose()).toBe(editor);
  expect(library().hidden).toBe(false);
});

it("原白板入口统一为文件系统，表格管理只有一个一级入口", async () => {
  await start();
  const bar = target.querySelector<HTMLElement>('[aria-label="组件栏"]')!;
  expect(
    [...bar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["目录", "搜索", "文件系统"]);
  expect(target.querySelector('.sidebar-actions [aria-label="资料管理"]')).toBeNull();
  bar.querySelector<HTMLButtonElement>('[aria-label="文件系统"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(library().hidden).toBe(false);
  });
  const table = library().querySelector('[role="grid"][aria-label="文件系统"]')!;
  expect(table).not.toBeNull();
  expect(table.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
  expect(target.querySelector(".boards-space")).toBeNull();
});
