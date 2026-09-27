/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@app/App.svelte";
import type { AppApi } from "../../../../apps/desktop/src/shared/api";
import type { ReaderApi } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
let api: ReaderApi;
let files: string[];
/** jsdom 没有弹层接口；分栏切走时格式面板会调用它，测试里补一个空实现。 */
let restoreHidePopover: (() => void) | null = null;

beforeEach(() => {
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
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom 尚未实现原生模态对话框；真实焦点与 Esc 由 Electron 用例覆盖。
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
  files = ["a.md", "notes/beta.md", "images/photo.png"];
  api = createReaderApiMock({
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      documents: {
        panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: ["notes/beta.md"],
    })),
    vaultEntries: vi.fn(async () => files.map((path) => ({ path, kind: "file" as const }))),
    fileSnapshot: vi.fn(async (path: string) => ({ disk: encode(`# ${path}\n`), draft: null })),
    indexNoteKeys: vi.fn(async () => [
      { path: "a.md", title: "a.md", aliases: [] },
      { path: "notes/beta.md", title: "Beta 标题", aliases: ["乙"] },
    ]),
    entryCreate: vi.fn(async (path: string) => {
      files = [...files, path];
      return { warning: null };
    }),
  });
  const appApi: AppApi = {
    historyChanged: vi.fn(),
    subscribeCommand: () => () => {},
    appearanceGet: vi.fn(async () => "system"),
    appearanceSet: vi.fn(async () => {}),
    subscribeFlushBeforeClose: () => () => {},
    closeAfterFlush: vi.fn(async () => {}),
    closeBlocked: vi.fn(async () => {}),
  };
  window.nous = { app: appApi, reader: api };
});

afterEach(async () => {
  await unmount(app);
  target.remove();
  restoreHidePopover?.();
  restoreHidePopover = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(App, { target });
  flushSync();
  const menu = target.querySelector<HTMLDivElement>(".file-menu")!;
  menu.showPopover = () => {};
  menu.hidePopover = () => {};
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".ProseMirror")).not.toBeNull();
    expect(target.querySelector(".panes")?.hasAttribute("inert")).toBe(false);
  });
}

function shortcut(key: string, shift = false): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, metaKey: true, shiftKey: shift, bubbles: true }),
  );
  flushSync();
}

function picker(): HTMLDialogElement | null {
  return target.querySelector<HTMLDialogElement>("dialog.picker[open]");
}

function options(): string[] {
  return [...(picker()?.querySelectorAll('[role="option"]') ?? [])].map(
    (option) => option.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

function type(text: string): void {
  const input = picker()!.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function press(key: string, modifiers: KeyboardEventInit = {}): void {
  picker()!
    .querySelector("input")!
    .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }));
  flushSync();
}

describe("快速切换器", () => {
  it("Cmd+O 打开，空查询按最近打开排列，Enter 在活动栏打开", async () => {
    await start();
    shortcut("o");
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    // 恢复时打开的 a.md 置顶，其后是会话里的最近记录，最后按路径补足。
    expect(options().map((text) => text.split(" ")[0])).toEqual(["a", "beta", "photo.png"]);
    type("bet");
    expect(options()[0]).toContain("beta");
    press("Enter");
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenLastCalledWith("notes/beta.md"));
    expect(picker()).toBeNull();
    expect(api.sessionSetRecentFiles).toHaveBeenLastCalledWith(["notes/beta.md", "a.md"]);
    // 真实桥接按结构化克隆传参；响应式代理会在 contextBridge 边界同步抛错。
    const sent = vi.mocked(api.sessionSetRecentFiles).mock.lastCall?.[0];
    expect(() => structuredClone(sent)).not.toThrow();
  });

  it("按别名命中时显示别名", async () => {
    await start();
    shortcut("o");
    await vi.waitFor(() => expect(api.indexNoteKeys).toHaveBeenCalled());
    type("乙");
    await vi.waitFor(() => expect(options()[0]).toContain("别名：乙"));
  });

  it("Cmd+Enter 拆栏并在另一栏打开", async () => {
    await start();
    shortcut("o");
    type("beta");
    press("Enter", { metaKey: true });
    await vi.waitFor(() => expect(target.querySelectorAll(".main")).toHaveLength(2));
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenLastCalledWith("notes/beta.md"));
    // 原栏保持原文档，新栏成为活动栏。
    expect(target.querySelector('section[data-pane="0"] .ProseMirror')?.textContent).toContain(
      "a.md",
    );
  });

  it("Shift+Enter 按输入新建笔记，无命中时 Enter 同样新建", async () => {
    await start();
    shortcut("o");
    type("beta");
    press("Enter", { shiftKey: true });
    await vi.waitFor(() =>
      expect(api.entryCreate).toHaveBeenCalledWith("beta.md", "file", undefined),
    );
    shortcut("o");
    type("全新的笔记");
    expect(options()).toEqual([]);
    press("Enter");
    await vi.waitFor(() =>
      expect(api.entryCreate).toHaveBeenLastCalledWith("全新的笔记.md", "file", undefined),
    );
  });
});

describe("命令面板", () => {
  it("Cmd+P 只列出可用命令，执行后关闭面板", async () => {
    await start();
    shortcut("p");
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    const labels = options();
    expect(labels.some((label) => label.startsWith("切换分栏"))).toBe(true);
    expect(labels.some((label) => label.startsWith("命令面板"))).toBe(false);
    // 恢复的文档没有阅读栈，后退不可用。
    expect(labels.some((label) => label.startsWith("后退"))).toBe(false);
    type("分栏");
    press("Enter");
    await vi.waitFor(() => expect(target.querySelectorAll(".main")).toHaveLength(2));
    expect(picker()).toBeNull();
    // 用过的命令在下一次空查询时置顶。
    shortcut("p");
    await vi.waitFor(() => expect(options()[0]).toContain("切换分栏"));
  });
});
