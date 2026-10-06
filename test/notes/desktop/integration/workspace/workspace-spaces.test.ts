/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@app/App.svelte";
import type {
  AppApi,
  AppCommand,
} from "../../../../../modules/notes/packages/desktop/src/shared/api";
import type { FileSnapshot, ReaderApi, VaultEntry } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

// jsdom 验证页面数据流；真实 Worker 与画布绘制由 Electron 用例覆盖。
vi.mock("@reader/renderer/graph/layout-client", async (original) => {
  const actual = await original<typeof import("@reader/renderer/graph/layout-client")>();
  return { ...actual, createWorkerLayout: actual.createInlineLayout };
});

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

async function createBoard(): Promise<void> {
  command("new-whiteboard");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".whiteboard")).not.toBeNull();
    expect(target.querySelector('[aria-label="关联与白板"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
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

  it("重复点击关联入口保留正在浏览的图谱，不被后台白板改回画布", async () => {
    await start();
    await createBoard();
    click("图谱");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="过滤图谱"]')).not.toBeNull();
    });
    target.querySelector<HTMLButtonElement>('[aria-label="关联与白板"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelector('[aria-label="过滤图谱"]')).not.toBeNull();
    expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("从白板返回写作先完成读取，失败时保持原页面与会话，不提前隐藏画布", async () => {
    await start();
    await createBoard();
    const previousCanvas = target.querySelector(".whiteboard");
    let finishRead!: (snapshot: FileSnapshot) => void;
    const reading = new Promise<FileSnapshot>((resolve) => {
      finishRead = resolve;
    });
    vi.mocked(api.fileSnapshot).mockImplementationOnce(() => reading);
    vi.mocked(api.fileSnapshot).mockClear();
    vi.mocked(api.sessionSetPanes).mockClear();
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledWith("note.md"));
    flushSync();
    const whileLoading = {
      page: target.querySelector('[aria-label="关联与白板"]')?.getAttribute("aria-current"),
      hidden: target.querySelector(".reading-space")?.getAttribute("aria-hidden"),
    };
    finishRead({ disk: null, draft: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".feedback-announcement")?.textContent).toContain("文件已不存在");
      expect(target.querySelector<HTMLButtonElement>(".space-button")?.disabled).toBe(false);
    });
    expect(whileLoading).toEqual({ page: "page", hidden: "false" });
    expect(target.querySelector(".whiteboard")).toBe(previousCanvas);
    expect(api.sessionSetPanes).not.toHaveBeenCalledWith(
      expect.objectContaining({ space: "writing" }),
    );
  });

  it("白板旁的空分栏被激活后显示写作起点，不保留无文档的画布标题", async () => {
    await start();
    await createBoard();
    command("toggle-split");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[data-pane="1"]')).not.toBeNull();
    });
    target
      .querySelector('[data-pane="1"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(target.querySelector('[aria-label="阅读与写作"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(target.querySelector(".connections.canvas")).toBeNull();
    expect(target.querySelector('[data-pane="1"] .welcome')).not.toBeNull();
  });

  it("返回写作的慢读取期间激活另一分栏，完成后仍按新活动栏归属显示", async () => {
    await start();
    await createBoard();
    command("toggle-split");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[data-pane="1"]')).not.toBeNull();
    });
    let finishRead!: (snapshot: FileSnapshot) => void;
    vi.mocked(api.fileSnapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    vi.mocked(api.fileSnapshot).mockClear();
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledWith("note.md"));
    target
      .querySelector('[data-pane="1"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    finishRead({ disk: disk.get("note.md")!, draft: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector<HTMLButtonElement>(".space-button")?.disabled).toBe(false);
    });
    expect(target.querySelector('[data-pane="1"]')?.classList.contains("active")).toBe(true);
    expect(target.querySelector('[aria-label="阅读与写作"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(target.querySelector(".connections.canvas")).toBeNull();
  });

  it("从图谱创建缺失笔记失败时留在图谱，不能跳回无关的旧文档", async () => {
    vi.mocked(api.indexGraph).mockImplementation(async (includeDead) => ({
      nodes: includeDead ? [{ path: "missing.md", title: "missing", tags: [], dead: true }] : [],
      edges: [],
    }));
    vi.mocked(api.entryCreate).mockRejectedValue(new Error("只读目录"));
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    await start();
    command("open-graph");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="过滤图谱"]')).not.toBeNull();
    });
    const label = [...target.querySelectorAll(".connections label")].find((item) =>
      item.textContent?.includes("未创建的笔记"),
    );
    label!.querySelector<HTMLInputElement>("input")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".connections .stats")?.textContent).toContain("1 个节点");
    });
    target
      .querySelector<HTMLInputElement>('[aria-label="过滤图谱"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector<HTMLDialogElement>(".dead-link-dialog")?.open).toBe(true);
    });
    click("创建笔记");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".feedback-announcement")?.textContent).toContain("只读目录");
    });
    expect(target.querySelector('[aria-label="关联与白板"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(prose().textContent).toContain("继续写作");
  });

  it("三个页面有稳定入口，关联页使用真实索引且不卸载正在写作的编辑器", async () => {
    await start();
    const editor = prose();
    const connections = target.querySelector<HTMLButtonElement>('[aria-label="关联与白板"]');
    expect(connections).not.toBeNull();
    connections!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="关联空间"]')).not.toBeNull();
      expect(connections!.getAttribute("aria-current")).toBe("page");
    });
    click("图谱");
    await vi.waitFor(() => expect(api.indexGraph).toHaveBeenCalledWith(false));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("过滤图谱");
    expect(prose()).toBe(editor);
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
    });
    expect(prose()).toBe(editor);
  });

  it("关联页也遵守保存门禁，冲突时不隐藏待处理的正文", async () => {
    await start();
    prose().querySelector("p")!.textContent = "不能丢失的编辑";
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("外部修改") });
    command("open-graph");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".save-notice")?.textContent).toContain("原文件已在其他地方修改");
    });
    expect(target.querySelector('[aria-label="关联空间"]')).toBeNull();
    expect(prose().textContent).toContain("不能丢失的编辑");
  });

  it("关联页面随会话恢复，白板打开后仍属于关联空间", async () => {
    vi.mocked(api.sessionGetPanes).mockResolvedValue({
      filesCollapsed: false,
      leftWidth: 232,
      space: "connections",
    });
    await start();
    expect(target.querySelector('[aria-label="关联空间"]')).not.toBeNull();
    command("new-whiteboard");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".whiteboard")).not.toBeNull();
      expect(target.querySelector('[aria-label="关联与白板"]')?.getAttribute("aria-current")).toBe(
        "page",
      );
    });
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(prose()?.textContent).toContain("继续写作");
      expect(target.querySelector('[aria-label="阅读与写作"]')?.getAttribute("aria-current")).toBe(
        "page",
      );
    });
  });
  it("只有白板的库仍能返回写作起点，不把白板当作普通正文显示", async () => {
    disk.clear();
    vi.mocked(api.vaultRestore).mockResolvedValue(null);
    await start();
    command("new-whiteboard");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".whiteboard")).not.toBeNull();
    });
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="开始写作"]')).not.toBeNull();
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("true");
    });
    command("new-note");
    await vi.waitFor(() => {
      flushSync();
      expect(prose()).not.toBeNull();
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
    });
    target.querySelector<HTMLButtonElement>('[aria-label="关联与白板"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".board-list")).not.toBeNull();
      expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("写作起点的组词阻止切换时，后台白板不能把页面重新带回画布", async () => {
    disk.clear();
    vi.mocked(api.vaultRestore).mockResolvedValue(null);
    await start();
    await createBoard();
    target.querySelector<HTMLButtonElement>('[aria-label="阅读与写作"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="开始写作"]')).not.toBeNull();
    });
    window.dispatchEvent(new CompositionEvent("compositionstart"));
    target.querySelector<HTMLButtonElement>('[aria-label="关联与白板"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".feedback-announcement")?.textContent).toContain("请先完成输入");
      expect(target.querySelector<HTMLButtonElement>(".space-button")?.disabled).toBe(false);
    });
    expect(target.querySelector('[aria-label="开始写作"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="阅读与写作"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    window.dispatchEvent(new CompositionEvent("compositionend"));
  });

  it("返回读写后立刻卸载工作区，待执行的焦点交接应取消", async () => {
    await start();
    await manage();
    vi.mocked(api.sessionSetPanes).mockClear();
    vi.mocked(api.sessionSetDocuments).mockClear();
    click("笔记");
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
    click("笔记");
    await vi.waitFor(() => {
      flushSync();
      expect(library().hidden).toBe(true);
    });
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
    click("笔记");
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
    expect(JSON.parse(new TextDecoder().decode(created))).toEqual({ version: 2, strokes: [] });
  });
});
