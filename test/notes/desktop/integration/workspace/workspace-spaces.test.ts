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
import { createAgentApiMock } from "../../fixtures/agent-api-mock";

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
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
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
  window.noemori = { app, reader: api, agent: createAgentApiMock() };
});
afterEach(async () => {
  if (component !== undefined) await unmount(component);
  target.remove();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
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
const library = () => target.querySelector<HTMLElement>(".list[aria-label=文件列表]")!;
const prose = () => target.querySelector<HTMLElement>(".ProseMirror")!;
function click(text: string): void {
  const button = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text,
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

async function confirmCreate(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector<HTMLDialogElement>(".create-dialog")?.open).toBe(true);
  });
  target.querySelector(".create-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
}

async function createBoard(): Promise<void> {
  command("new-whiteboard");
    await confirmCreate();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".whiteboard")).not.toBeNull();
    expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
  });
}

describe("统一工作台", () => {
  it("目录和笔记库共用正文，切换导航不卸载编辑器", async () => {
    await start(); const editor = prose();
    click("文章大纲"); expect(library().hidden).toBe(true);
    await manage(); expect(library().hidden).toBe(false);
    expect(prose()).toBe(editor);
    expect(target.querySelector(".library-preview")).toBeNull();
  });
  it("单击打开同一文档表面，修饰键多选不切换文档", async () => {
    await start(); await manage();
    library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(prose().textContent).toContain("仅供预览"); });
    const editor = prose();
    library().querySelector<HTMLButtonElement>('[data-path="note.md"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    flushSync(); expect(prose()).toBe(editor);
    expect(library().querySelector(".selection-status")?.textContent).toContain("已选 2 项");
  });
  it("打开另一文件仍先保存，冲突时正文和输入保持可处理", async () => {
    await start();
    prose().querySelector("p")!.textContent = "不能丢失的编辑";
    await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("外部修改") });
    library().querySelector<HTMLButtonElement>('[data-path="other.md"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector(".save-notice")?.textContent).toContain("原文件已在其他地方修改"); });
    expect(prose().textContent).toContain("不能丢失的编辑");
    expect(target.querySelector(".reading-space")?.hasAttribute("inert")).toBe(false);
  });
  it("全局搜索只有一个输入与查询，切换目录保持正文和查询", async () => {
    await start(); const editor = prose(); command("find-files");
    await vi.waitFor(() => expect(document.activeElement).toBe(library().querySelector("input")));
    const search = library().querySelector<HTMLInputElement>("input")!;
    search.value = "继续"; search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(api.searchQuery).toHaveBeenCalled());
    click("文章大纲"); await manage();
    expect(search.value).toBe("继续"); expect(prose()).toBe(editor);
    expect(target.querySelectorAll('[role="searchbox"]')).toHaveLength(1);
  });
  it("旧文件页面会话迁入同一文档工作台，恢复查询和侧栏宽度", async () => {
    vi.mocked(api.sessionGetPanes).mockResolvedValue({ filesCollapsed: false, leftWidth: 250, destination: "library", sidebarView: "search", searchQuery: "工作台", rightWidth: 420 });
    await start(); expect(library().hidden).toBe(false);
    expect(library().querySelector<HTMLInputElement>("input")?.value).toBe("工作台");
    expect(prose().textContent).toContain("继续写作");
    expect(target.querySelector('.right [role="separator"]')?.getAttribute("aria-valuenow")).toBe("420");
  });
  it("左右侧栏都保留挂载；开关 Agent 不影响文档操作", async () => {
    await start(); const editor = prose(); const agent = target.querySelector(".agent-panel");
    click("工作区助手"); expect(target.querySelector<HTMLElement>(".file-sidebar.right")?.hidden).toBe(false);
    expect(target.querySelector(".panes")?.hasAttribute("inert")).toBe(false);
    command("new-note"); await confirmCreate();
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalled());
    expect(target.querySelector<HTMLElement>(".file-sidebar.right")?.hidden).toBe(false);
    click("工作区助手");
    await vi.waitFor(() => { flushSync(); expect(target.querySelector<HTMLElement>(".file-sidebar.right")?.hidden).toBe(true); });
    expect(target.querySelector(".agent-panel")).toBe(agent);
    expect(editor?.isConnected).toBe(false);
  });
  it("连续调整侧栏宽度只保存最终布局", async () => {
    await start(); vi.useFakeTimers(); vi.mocked(api.sessionSetPanes).mockClear();
    try {
      const handle = target.querySelector<HTMLElement>('[aria-label="调整侧栏宽度"]')!;
      for (let i = 0; i < 12; i++) { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); flushSync(); }
      await vi.advanceTimersByTimeAsync(300);
      expect(api.sessionSetPanes).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.sessionSetPanes).mock.calls[0]?.[0].leftWidth).toBe(Number(handle.getAttribute("aria-valuenow")));
    } finally { vi.useRealTimers(); }
  });
  it("窄窗口 Escape 收起文件抽屉，输入法 Escape 不触发导航", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 }); await start(); await manage();
    const input = library().querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })); flushSync();
    expect(target.querySelector<HTMLElement>(".content-space")?.inert).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); flushSync();
    expect(target.querySelector<HTMLElement>(".content-space")?.inert).toBe(false);
  });
  it("首次新建确认名称位置后才写盘，后续沿用当前目录", async () => {
    vi.mocked(api.vaultRestore).mockResolvedValue(null); vi.mocked(api.vaultOpen).mockResolvedValue({ root: "/notes", entries: [] }); disk.clear();
    await start(); command("new-note");
    await vi.waitFor(() => { flushSync(); expect(target.querySelector<HTMLDialogElement>(".create-dialog")?.open).toBe(true); });
    expect(api.entryCreate).not.toHaveBeenCalled(); await confirmCreate();
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalledWith("未命名.md", "file", undefined));
    await vi.waitFor(() => { flushSync(); expect(prose()).not.toBeNull(); });
    command("new-note"); await confirmCreate();
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalledWith("未命名 2.md", "file", undefined));
  });
  it("切换笔记库与目录不重建白板", async () => {
    await start(); await createBoard(); const board = target.querySelector(".whiteboard");
    await manage(); click("文章大纲"); expect(target.querySelector(".whiteboard")).toBe(board);
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
  await vi.waitFor(() => { flushSync(); expect(settings.open).toBe(false); });
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

it("新建白板菜单和命令进入同一名称位置确认流程", async () => {
  await start(); click("新建白板"); await confirmCreate();
  await vi.waitFor(() => { flushSync(); expect(target.querySelector(".whiteboard")).not.toBeNull(); });
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
    vi.mocked(api.vaultEntries).mockImplementation(async () => [
      { path: "docs", kind: "directory" },
      ...[...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
    ]);
    await start();
    await manage();
    library()
      .querySelector<HTMLButtonElement>('[data-path="docs"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    flushSync();
    library().querySelector<HTMLButtonElement>('[data-path="docs/other.md"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(prose().textContent).toContain("目录内文件"); });
    command(action);
    await confirmCreate();
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalled());
    expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toMatch(/^docs\//);
  },
);

it.each(["范围多选", "取消文件夹选择", "仅选择文件夹"])(
  "新建沿用最后进入的目录，批量选择不改变保存位置（%s）",
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
    await confirmCreate();
    await vi.waitFor(() => expect(api.entryCreate).toHaveBeenCalled());
    expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toBe(
      selection === "仅选择文件夹" ? "未命名.md" : "docs/未命名.md",
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
    vi.mocked(api.vaultEntries).mockImplementation(async () => [
      { path: "docs", kind: "directory" },
      ...[...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
    ]);
    await start();
    for (const entry of ["button", "command"] as const) {
      await manage();
      const search = library().querySelector<HTMLInputElement>('[role="searchbox"]')!;
      search.value = "docs/other.md";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      library().querySelector<HTMLButtonElement>('[data-path="docs/other.md"]')!.click();
      await vi.waitFor(() => { flushSync(); expect(prose().textContent).toContain("目录内文件"); });
      vi.mocked(api.entryCreate).mockClear();
      if (entry === "command") command(action);
      else click(label);
      await confirmCreate();
      await vi.waitFor(() => {
        flushSync();
        expect(api.entryCreate).toHaveBeenCalled();
        expect(library().hidden).toBe(false);
      });
      expect(vi.mocked(api.entryCreate).mock.calls[0]?.[0]).toMatch(/^docs\//);
    }
  },
);

it("文件系统使用单一层级目录，展开和搜索保留正文与应用入口", async () => {
  disk.set("docs/guide.md", encode("# 指南\n"));
  vi.mocked(api.vaultEntries).mockImplementation(async () => [
    { path: "docs", kind: "directory" },
    ...[...disk.keys()].map((path): VaultEntry => ({ path, kind: "file" })),
  ]);
  await start();
  const editor = prose();
  await manage();
  expect(target.querySelector('[aria-label="文件夹导航"]')).toBeNull();
  expect(target.querySelector(".file-sidebar.compact")).toBeNull();
  expect(target.querySelector('[aria-label="设置"]')).not.toBeNull();
  library().querySelector<HTMLButtonElement>('[data-path="docs"]')!.click();
  flushSync();
  expect(library().querySelector('[data-path="docs/guide.md"]')).not.toBeNull();
  expect(library().querySelector('[data-path="note.md"]')).not.toBeNull();
  const search = library().querySelector<HTMLInputElement>('[role="searchbox"]')!;
  search.value = "guide";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(library().querySelector('[data-path="docs"]')).not.toBeNull();
  expect(library().querySelector('[data-path="note.md"]')).toBeNull();
  expect(prose()).toBe(editor);
  expect(library().hidden).toBe(false);
});

it("文件与大纲入口名称固定，切换视图保留正文与键盘焦点", async () => {
  await start();
  const editor = prose();
  const outline = target.querySelector<HTMLButtonElement>('.navigation-heading [aria-label="文章大纲"]')!;
  const files = target.querySelector<HTMLButtonElement>('.navigation-heading [aria-label="文件目录"]')!;
  expect(outline.textContent?.trim()).toBe("大纲");
  expect(files.textContent?.trim()).toBe("文件");
  expect(files.getAttribute("aria-pressed")).toBe("true");
  outline.focus();
  outline.click();
  flushSync();
  expect(outline.getAttribute("aria-pressed")).toBe("true");
  expect(files.getAttribute("aria-pressed")).toBe("false");
  expect(library().hidden).toBe(true);
  expect(document.activeElement).toBe(outline);
  files.click();
  flushSync();
  expect(files.getAttribute("aria-pressed")).toBe("true");
  expect(outline.getAttribute("aria-label")).toBe("文章大纲");
  expect(library().hidden).toBe(false);
  expect(prose()).toBe(editor);
  expect(library().querySelectorAll('[role="treegrid"]')).toHaveLength(1);
  expect(target.querySelector(".conversation-sidebar")).toBeNull();
});

it("关闭再打开右栏保留同一个会话、输入节点和未发送草稿，保存失败时保留面板", async () => {
  const item = {
    id: "session", title: "当前对话", workspace: "/notes", model: "fixture", createdAt: 1, updatedAt: 1,
    archived: false, origin: null, article: null, draft: "原草稿", storageError: null, revision: 0,
    closed: false, run: null, turns: [], messages: [], terminals: [], approvals: [],
    browser: { status: "idle" as const, tabs: [], receipts: [], error: null },
    ui: { status: "idle" as const, generation: 0, call: null, error: null, control: null, connections: [], receipts: [] },
  };
  window.noemori.agent.list = async () => ({ items: [{ ...item, status: null }], issues: [] });
  window.noemori.agent.snapshot = vi.fn(async () => structuredClone(item));
  const save = vi.fn(async (_id: string, text: string) => { item.draft = text; });
  window.noemori.agent.saveDraft = save;
  await start(); click("工作区助手");
  await vi.waitFor(() => { flushSync(); expect(target.querySelector(".composer textarea")).not.toBeNull(); });
  const field = target.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  field.value = "下一次继续的内容"; field.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
  save.mockRejectedValueOnce(new Error("草稿写入失败"));
  click("工作区助手");
  await vi.waitFor(() => { flushSync(); expect(target.querySelector(".close-error")?.textContent).toContain("草稿写入失败"); });
  expect(target.querySelector<HTMLElement>(".file-sidebar.right")!.hidden).toBe(false);
  click("工作区助手");
  await vi.waitFor(() => { flushSync(); expect(target.querySelector<HTMLElement>(".file-sidebar.right")!.hidden).toBe(true); });
  click("工作区助手"); flushSync();
  expect(target.querySelector(".composer textarea")).toBe(field);
  expect(field.value).toBe("下一次继续的内容");
  expect(window.noemori.agent.snapshot).toHaveBeenCalledTimes(1);
});

it("已有文件树中的空查询优先于旧版侧栏搜索，重启不会复活已清除的关键词", async () => {
  vi.mocked(api.sessionGetPanes).mockResolvedValue({ filesCollapsed: false, leftWidth: 232, sidebarView: "files", searchQuery: "旧关键词" });
  const restore = vi.mocked(api.vaultRestore).getMockImplementation()!;
  vi.mocked(api.vaultRestore).mockImplementation(async (...args) => {
    const restored = await restore(...args);
    return restored ? { ...restored, fileTree: { expanded: [], selected: [], focused: null, scroll: null, browse: { query: "", section: "files" } } } : null;
  });
  await start();
  expect(library().querySelector<HTMLInputElement>("input")?.value).toBe("");
  expect(api.searchQuery).not.toHaveBeenCalled();
});

it("搜索只有一个输入入口，从大纲返回文件时保留查询与正文，搜索命令仍聚焦输入", async () => {
  await start();
  const editor = prose();
  const heading = target.querySelector(".navigation-heading")!;
  expect(heading.querySelector('[aria-label="搜索笔记库"]')).toBeNull();
  expect(heading.querySelector('[aria-label="新建"]')).not.toBeNull();
  expect(target.querySelectorAll('[role="searchbox"][aria-label="搜索笔记库"]')).toHaveLength(1);
  const input = library().querySelector<HTMLInputElement>('[role="searchbox"]')!;
  input.value = "继续";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  click("文章大纲");
  expect(library().hidden).toBe(true);
  click("文件目录");
  expect(input.value).toBe("继续");
  click("文章大纲");
  command("find-files");
  await vi.waitFor(() => {
    flushSync();
    expect(library().hidden).toBe(false);
    expect(document.activeElement).toBe(input);
  });
  expect(input.value).toBe("继续");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(prose()).toBe(editor);
});

it("笔记菜单和编辑器不再提供属性入口或属性面板", async () => {
  await start();
  expect([...target.querySelectorAll(".note-menu button")].some(button => button.textContent?.includes("笔记属性"))).toBe(false);
  expect(target.querySelector('[aria-label="笔记属性"]')).toBeNull();
  expect(target.querySelector(".properties")).toBeNull();
});
