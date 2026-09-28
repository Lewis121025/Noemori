/** @vitest-environment jsdom */
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import type { ReaderApi } from "@reader/shared/api";
import type { SessionHistory } from "@reader/shared/session";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function createApi(overrides: Partial<ReaderApi> = {}): ReaderApi {
  return createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "a.md", kind: "file" as const },
      { path: "b.md", kind: "file" as const },
      { path: "c.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async (path: string) => ({
      disk: encode(`# ${path}\n\n正文。\n`),
      draft: null,
    })),
    ...overrides,
  });
}

async function startWorkspace(api: ReaderApi): Promise<ReaderWorkspaceController> {
  const workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  flushSync();
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("阅读栈导航", () => {
  it("普通打开从文首开始，加载失败和改名保留原阅读位置", async () => {
    const api = createApi();
    const workspace = await startWorkspace(api);
    await workspace.openFile("a.md");
    let top = 720;
    workspace.history.attachScroll({
      capture: () => top,
      reset: () => {
        top = 0;
      },
      apply: (value) => {
        top = value;
      },
    });
    vi.mocked(api.fileSnapshot).mockResolvedValueOnce({ disk: null, draft: null });
    await workspace.openFile("b.md");
    expect(workspace.document.path).toBe("a.md");
    expect(top).toBe(720);
    expect(workspace.history.canBack).toBe(false);

    await workspace.renameEntry("a.md", "renamed.md");
    expect(workspace.document.path).toBe("renamed.md");
    expect(top).toBe(720);
    await workspace.openFile("b.md");
    expect(top).toBe(0);
    await workspace.navigateBack();
    expect(workspace.document.path).toBe("renamed.md");
    expect(top).toBe(720);
  });

  it("同文档锚点跳转先记录出发位置，后退与前进恢复各自停留的段落", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    let top = 480;
    workspace.history.attachScroll({
      capture: () => top,
      reset: () => {
        top = 0;
      },
      apply: (value) => {
        top = value;
      },
    });
    vi.spyOn(workspace.navigation, "jumpToHeadingText").mockImplementation(() => {
      top = 1200;
      return true;
    });
    const jump = vi.spyOn(workspace.navigation, "openHeadingAnchor");

    await workspace.activePane.openResolved("a.md", "小节");
    expect(top).toBe(1200);
    top = 1560;
    await workspace.navigateBack();
    expect(top).toBe(480);
    await workspace.navigateForward();
    expect(top).toBe(1560);
    expect(jump).not.toHaveBeenCalled();
  });

  it("从锚点继续阅读后离开，后退恢复离开时的位置而非旧标题", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    let top = 0;
    workspace.history.attachScroll({
      capture: () => top,
      reset: () => {
        top = 0;
      },
      apply: (value) => {
        top = value;
      },
    });
    vi.spyOn(workspace.navigation, "jumpToHeadingText").mockReturnValue(true);
    await workspace.activePane.openResolved("a.md", "小节");
    top = 1800;
    await workspace.openFile("b.md");
    top = 320;
    const jump = vi.spyOn(workspace.navigation, "openHeadingAnchor");
    await workspace.navigateBack();
    expect(workspace.document.path).toBe("a.md");
    expect(top).toBe(1800);
    expect(jump).not.toHaveBeenCalled();
  });

  it("失效的文内锚点不改变当前阅读位置或历史", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    const apply = vi.fn();
    workspace.history.attachScroll({ capture: () => 480, reset: () => {}, apply });
    vi.spyOn(workspace.navigation, "jumpToHeadingText").mockReturnValue(false);
    await workspace.activePane.openResolved("a.md", "失效标题");
    expect(workspace.history.canBack).toBe(false);
    expect(workspace.activePane.currentStep).toEqual({ path: "a.md", anchor: null });
    expect(apply).not.toHaveBeenCalled();
    expect(workspace.message).toContain("未找到标题");
  });

  it("历史恢复完成前保持本栏门禁，后续导航不会被迟到的滚动覆盖", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    let release: (() => void) | undefined;
    const applied = new Promise<void>((resolve) => {
      release = resolve;
    });
    workspace.history.attachScroll({ capture: () => 640, reset: () => {}, apply: () => applied });
    await workspace.openFile("b.md");
    const back = workspace.navigateBack();
    await settle();
    expect(workspace.activePane.switching).toBe(true);
    await workspace.openFile("c.md");
    expect(workspace.document.path).toBe("a.md");
    release?.();
    await back;
    expect(workspace.activePane.switching).toBe(false);
  });

  it("打开文件依次入栈，后退与前进按浏览器语义移动", async () => {
    const sessionSetDocuments = vi.fn(async () => {});
    const workspace = await startWorkspace(createApi({ sessionSetDocuments }));
    await workspace.openFile("a.md");
    await workspace.openFile("b.md");
    await workspace.openFile("c.md");
    expect(workspace.document.path).toBe("c.md");
    expect(workspace.history.canBack).toBe(true);

    await workspace.navigateBack();
    await settle();
    expect(workspace.document.path).toBe("b.md");
    await workspace.navigateBack();
    await settle();
    expect(workspace.document.path).toBe("a.md");
    expect(workspace.history.canForward).toBe(true);

    await workspace.navigateForward();
    await settle();
    expect(workspace.document.path).toBe("b.md");

    // 新导航使前进栈失效。
    await workspace.openFile("c.md");
    await settle();
    expect(workspace.history.canForward).toBe(false);

    // 每次移动都持久化快照（活动栏的阅读栈随文档会话写入）。
    const last = sessionSetDocuments.mock.calls.at(-1)?.[0]?.panes[0]
      ?.history as SessionHistory;
    expect(last.back.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
  });

  it("空栈时后退前进不动文档也不报错", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    await workspace.navigateBack();
    await settle();
    expect(workspace.document.path).toBe("a.md");
    await workspace.navigateForward();
    await settle();
    expect(workspace.document.path).toBe("a.md");
  });

  it("恢复会话时按当前文件列表过滤失效条目", async () => {
    const workspace = await startWorkspace(
      createApi({
        vaultRestore: vi.fn(async () => ({
          root: "/notes",
          documents: {
            panes: [
              {
                currentPath: "b.md",
                history: {
                  back: [
                    { path: "gone.md", anchor: null },
                    { path: "a.md", anchor: null },
                  ],
                  forward: [],
                },
              },
            ],
            active: 0,
            split: false,
          },
          viewModes: {},
          recentFiles: [],
        })),
      }),
    );
    expect(workspace.document.path).toBe("b.md");
    await workspace.navigateBack();
    await settle();
    expect(workspace.document.path).toBe("a.md");
    expect(workspace.history.canBack).toBe(false);
  });

  it("重命名后历史条目跟随新路径", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    await workspace.openFile("b.md");
    await workspace.renameEntry("a.md", "renamed.md");
    await settle();
    await workspace.navigateBack();
    await settle();
    expect(workspace.document.path).toBe("renamed.md");
  });

  it("删除文件后其历史条目被移除", async () => {
    const workspace = await startWorkspace(createApi());
    await workspace.openFile("a.md");
    await workspace.openFile("b.md");
    await workspace.trashEntry("a.md");
    await settle();
    expect(workspace.history.canBack).toBe(false);
  });
});
