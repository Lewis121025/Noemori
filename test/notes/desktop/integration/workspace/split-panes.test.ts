/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@app/App.svelte";
import type {
  AppApi,
  AppCommand,
} from "../../../../../modules/notes/packages/desktop/src/shared/api";
import type { FileSnapshot, ReaderApi, WriteResult } from "@reader/shared/api";
import type { SessionDocuments } from "@reader/shared/session";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
let onCommand: (command: AppCommand) => void;
let disk: Map<string, Uint8Array>;
let documents: SessionDocuments;
let api: ReaderApi;
/** jsdom 没有弹层接口；分栏切走时格式面板会调用它，测试里补一个空实现。 */
let restoreHidePopover: (() => void) | null = null;

function pane(id: number): HTMLElement {
  const section = target.querySelector<HTMLElement>(`section[data-pane="${id}"]`);
  expect(section, `分栏 ${id}`).not.toBeNull();
  return section!;
}

function prose(id: number): string {
  return pane(id).querySelector(".ProseMirror")?.textContent ?? "";
}

/** 分栏自身或祖先处于 inert 时，这一栏不能编辑。 */
function blocked(id: number): boolean {
  let node: HTMLElement | null = pane(id);
  while (node !== null) {
    if (node.inert) return true;
    node = node.parentElement;
  }
  return false;
}

function activatePane(id: number): void {
  pane(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flushSync();
}

function clickPath(path: string): void {
  const button = target.querySelector<HTMLButtonElement>(
    `.quick-navigation button[data-path="${path}"]`,
  );
  expect(button, path).not.toBeNull();
  button!.click();
  flushSync();
}

async function editPane(id: number, text: string): Promise<void> {
  const paragraph = pane(id).querySelector(".ProseMirror p");
  expect(paragraph, `分栏 ${id} 正文`).not.toBeNull();
  paragraph!.textContent = text;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  flushSync();
}

beforeEach(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const proto = HTMLElement.prototype as HTMLElement & { hidePopover?: () => void };
  if (typeof proto.hidePopover !== "function") {
    const previous = proto.hidePopover;
    proto.hidePopover = () => {};
    restoreHidePopover = () => {
      proto.hidePopover = previous;
    };
  }
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
    ["third.md", encode("third\n")],
  ]);
  documents = {
    panes: [{ currentPath: "note.md", history: { back: [], forward: [] } }],
    active: 0,
    split: false,
  };
  api = createReaderApiMock({
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      entries: await api.vaultEntries(),
      documents,
      viewModes: {},
      recentFiles: [],
    })),
    vaultList: vi.fn(async () => [...disk.keys()]),
    vaultEntries: vi.fn(async () =>
      [...disk.keys()].map((path) => ({ path, kind: "file" as const })),
    ),
    fileRead: vi.fn(async (path: string) => disk.get(path)!),
    fileSnapshot: vi.fn(async (path: string) => ({ disk: disk.get(path) ?? null, draft: null })),
    fileWrite: vi.fn(async (path: string, bytes: Uint8Array) => {
      disk.set(path, bytes);
      return { status: "saved" as const, warning: null };
    }),
  });
  const appApi: AppApi = {
    historyChanged: vi.fn(),
    subscribeCommand: (callback) => {
      onCommand = callback;
      return () => {};
    },
    appearanceGet: vi.fn(async () => "system"),
    appearanceSet: vi.fn(async () => {}),
    subscribeFlushBeforeClose: () => () => {},
    closeAfterFlush: vi.fn(async () => {}),
    closeBlocked: vi.fn(async () => {}),
  };
  window.noemori = { app: appApi, reader: api };
});

afterEach(async () => {
  await unmount(app);
  target.remove();
  restoreHidePopover?.();
  restoreHidePopover = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(text = "base"): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(App, { target });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(prose(0)).toBe(text);
    expect(blocked(0)).toBe(false);
  });
}

async function openInPane(id: number, path: string, text: string): Promise<void> {
  activatePane(id);
  clickPath(path);
  await vi.waitFor(() => {
    flushSync();
    expect(prose(id)).toBe(text);
  });
}

describe("双栏编辑", () => {
  it("非活动栏的在途保存发生冲突后仍可见，重试只保存所属笔记", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");
    const saving = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(saving.promise);
    activatePane(0);
    await editPane(0, "需要保留的编辑");
    onCommand("save");
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    activatePane(1);
    saving.resolve({ status: "conflict", disk: encode("外部版本\n") });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="处理保存问题"]')).not.toBeNull();
    });
    expect(target.querySelector(".document-name")?.textContent).toBe("other.md");
    expect(target.querySelector(".save-status")?.textContent).toBe("已保存");
    const issue = target.querySelector<HTMLElement>('[aria-label="保存问题：note.md"]');
    expect(issue).not.toBeNull();
    const retry = [...issue!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "重试保存",
    )!;
    retry.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="处理保存问题"]')).toBeNull();
    });
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note.md",
      encode("需要保留的编辑\n"),
      encode("base\n"),
    );
    expect(target.querySelector(".document-name")?.textContent).toBe("other.md");
    expect(prose(1)).toBe("other");
  });

  it("进入资料管理被另一栏保存失败阻止时，说明文件名并允许定位该栏", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");
    await editPane(0, "尚未保存");
    activatePane(1);
    vi.mocked(api.fileWrite).mockRejectedValue(new Error("磁盘暂不可写"));
    [...target.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "资料管理")!
      .click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".message")?.textContent).toContain("note.md");
      expect(target.querySelector('[aria-label="处理保存问题"]')).not.toBeNull();
    });
    expect(target.querySelector(".reading-space")?.getAttribute("aria-hidden")).toBe("false");
    target.querySelector<HTMLButtonElement>('[aria-label="前往笔记：note.md"]')!.click();
    flushSync();
    expect(target.querySelector(".document-name")?.textContent).toBe("note.md");
    expect(prose(0)).toBe("尚未保存");
    expect(prose(1)).toBe("other");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "saved", warning: null });
    onCommand("save");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="处理保存问题"]')).toBeNull();
      expect(target.querySelector(".message")).toBeNull();
    });
  });

  it("两栏同时打开不同笔记，各自编辑不互相改写", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    expect(target.querySelectorAll("section[data-pane]")).toHaveLength(2);

    await openInPane(1, "other.md", "other");
    expect(prose(0)).toBe("base");

    await editPane(0, "左边改过");
    activatePane(1);
    await editPane(1, "右边改过");

    expect(prose(0)).toBe("左边改过");
    expect(prose(1)).toBe("右边改过");
    activatePane(0);
    flushSync();
    expect(target.querySelector(".save-status")?.textContent).toBe("未保存");
    activatePane(1);
    flushSync();
    expect(target.querySelector(".save-status")?.textContent).toBe("未保存");
  });

  it("一栏加载文件时，另一栏保持可编辑", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");

    const pending = deferred<FileSnapshot>();
    vi.mocked(api.fileSnapshot).mockImplementation(async (path: string) => {
      if (path === "third.md") return pending.promise;
      return { disk: disk.get(path) ?? null, draft: null };
    });
    activatePane(0);
    clickPath("third.md");
    await vi.waitFor(() => {
      flushSync();
      expect(blocked(0)).toBe(true);
    });

    expect(blocked(1)).toBe(false);
    expect(prose(1)).toBe("other");
    const searchBox = target.querySelector<HTMLInputElement>('[aria-label="搜索文件和全文"]');
    expect(searchBox?.disabled).toBe(true);
    searchBox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(api.searchQuery).not.toHaveBeenCalled();
    await editPane(1, "加载期间仍可写");
    expect(prose(1)).toBe("加载期间仍可写");

    pending.resolve({ disk: disk.get("third.md")!, draft: null });
    await vi.waitFor(() => {
      flushSync();
      expect(prose(0)).toBe("third");
      expect(blocked(0)).toBe(false);
    });
    expect(prose(1)).toBe("加载期间仍可写");
    expect(searchBox?.disabled).toBe(false);
  });

  it("两栏的编辑工具栏绑定各自文档，模式切换对两栏同时生效", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");
    expect(
      [...target.querySelectorAll<HTMLElement>(".formatting-panel")].map((panel) => panel.id),
    ).toEqual(["editor-formatting-0", "editor-formatting-1"]);
    target.querySelector<HTMLButtonElement>('[aria-label="切换阅读模式"]')!.click();
    await vi.waitFor(() => expect(target.querySelectorAll(".formatting-panel")).toHaveLength(0));
    expect(
      [...target.querySelectorAll(".ProseMirror")].every(
        (node) => node.getAttribute("contenteditable") === "true",
      ),
    ).toBe(true);
    activatePane(0);
    expect(target.querySelectorAll(".formatting-panel")).toHaveLength(0);
    target.querySelector<HTMLButtonElement>('[aria-label="切换编辑模式"]')!.click();
    await vi.waitFor(() => expect(target.querySelectorAll(".formatting-panel")).toHaveLength(2));
  });

  it("两栏的后退与滚动位置互不覆盖", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");

    activatePane(0);
    pane(0).scrollTop = 80;
    clickPath("third.md");
    await vi.waitFor(() => {
      flushSync();
      expect(prose(0)).toBe("third");
    });
    pane(1).scrollTop = 30;

    onCommand("go-back");
    await vi.waitFor(() => {
      flushSync();
      expect(prose(0)).toBe("base");
      expect(pane(0).scrollTop).toBe(80);
    });
    expect(prose(1)).toBe("other");
    expect(pane(1).scrollTop).toBe(30);
  });

  it("重启后恢复分栏、各自文档与阅读栈", async () => {
    await start();
    target.querySelector<HTMLButtonElement>('[aria-label="拆分为两栏"]')!.click();
    flushSync();
    await openInPane(1, "other.md", "other");
    await openInPane(0, "third.md", "third");

    const saved = vi.mocked(api.sessionSetDocuments).mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({
      split: true,
      active: 0,
      panes: [
        { currentPath: "third.md", history: { back: [{ path: "note.md", anchor: null }] } },
        { currentPath: "other.md", history: { back: [], forward: [] } },
      ],
    });

    documents = saved!;
    await unmount(app);
    target.remove();
    await start("third");

    expect(target.querySelectorAll("section[data-pane]")).toHaveLength(2);
    expect(prose(0)).toBe("third");
    expect(prose(1)).toBe("other");
    expect(target.querySelector(".document-name")?.textContent).toBe("third.md");

    onCommand("go-back");
    await vi.waitFor(() => {
      flushSync();
      expect(prose(0)).toBe("base");
    });
    expect(prose(1)).toBe("other");
  });
});
