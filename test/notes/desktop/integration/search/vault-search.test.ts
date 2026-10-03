/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryBrowser from "@reader/renderer/library/LibraryBrowser.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { ReaderApi, SearchHit, SearchPage, VaultEvent } from "@reader/shared/api";
import { SEARCH_DEPTH_LIMIT } from "@reader/shared/reader-protocol";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function createApi(overrides: Partial<ReaderApi> = {}): ReaderApi {
  return createReaderApiMock({
    vaultList: vi.fn(async () => ["alpha.md", "notes/beta.md"]),
    vaultEntries: vi.fn(async () => [
      { path: "alpha.md", kind: "file" as const },
      { path: "notes", kind: "directory" as const },
      { path: "notes/beta.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n\n正文 hit word\n"), draft: null })),
    fileWriteCopy: vi.fn(async () => ({ path: "notes/beta (副本).md", warning: null })),
    ...overrides,
  });
}

let target: HTMLDivElement;
let component: LibraryBrowser;
let workspace: ReaderWorkspaceController;
let onOpen: ReturnType<typeof vi.fn>;
let onEdit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom 没有布局引擎；目录视口的测量在 Electron 用例覆盖。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function startList(api: ReaderApi): Promise<void> {
  workspace = new ReaderWorkspaceController(api);
  target = document.createElement("div");
  document.body.append(target);
  onOpen = vi.fn();
  onEdit = vi.fn();
  component = mount(LibraryBrowser, {
    target,
    props: { workspace, readFile: api.fileRead, onEdit, onOpen },
  });
  await workspace.restore();
  flushSync();
  const menu = target.querySelector<HTMLDivElement>(".file-menu")!;
  menu.showPopover = () => {};
  menu.hidePopover = () => {};
}

function searchBox(): HTMLInputElement {
  const input = target.querySelector<HTMLInputElement>('input[role="searchbox"]');
  if (input === null) throw new Error("搜索框不存在");
  return input;
}

async function typeAndSubmit(text: string): Promise<void> {
  const input = searchBox();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  flushSync();
}

describe("侧栏全文搜索", () => {
  it("融合状态与相关段落独立展示，不虚构精确命中数", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [{ path: "notes/beta.md", title: "幂等性", snippet: "重复请求只处理一次", contentHash: "a".repeat(64), matches: [], matchCount: 0, matchesCursor: null,
        evidence: [{ kind: "semantic", snippet: "重复请求只处理一次", location: { startByte: 2, endByte: 8, line: 1 } }] }],
      nextCursor: null, semantic: { state: "indexing", indexed: 1, total: 2, message: null }, limited: true,
    }));
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("如何防止重复处理");
    expect(target.querySelector(".status")?.textContent).toContain("1 篇相关笔记");
    expect(target.querySelector(".semantic-status")?.textContent).toContain("1 / 2");
    expect(target.querySelector(".semantic-evidence")?.textContent).toContain("相关段落");
    expect(target.querySelector(".expand")).toBeNull();
    const evidence = target.querySelector<HTMLButtonElement>(".semantic-evidence")!;
    evidence.focus();
    evidence.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(target.querySelector(".hit"));
  });

  it("模型下载仅由明确点击发起", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({ hits: [], nextCursor: null,
      semantic: { state: "missing", indexed: 0, total: 2, message: null }, limited: false }));
    const searchModelInstall = vi.fn(async () => null);
    await startList(createApi({ searchQuery, searchModelInstall }));
    await typeAndSubmit("如何检索");
    expect(searchModelInstall).not.toHaveBeenCalled();
    const download = Array.from(target.querySelectorAll("button")).find((button) => button.textContent?.includes("下载语义模型"));
    download?.click();
    await settle();
    expect(searchModelInstall).toHaveBeenCalledWith("download", expect.any(String));
  });

  it.each([false, true])(
    "库变化自动更新结果（包含命中：%s），刷新期间保留查询和焦点",
    async (hasHit) => {
      let changed: ((event: VaultEvent) => void) | undefined;
      const hit: SearchHit = {
        path: "alpha.md",
        title: "Alpha",
        snippet: "needle",
        contentHash: "a".repeat(64),
        matches: [{ snippet: "needle", location: { startByte: 0, endByte: 6, line: 1 } }],
        matchCount: 1,
        matchesCursor: null,
      };
      const searchQuery = vi
        .fn<ReaderApi["searchQuery"]>()
        .mockResolvedValueOnce({ hits: hasHit ? [hit] : [], nextCursor: null })
        .mockResolvedValueOnce({ hits: [hit], nextCursor: null });
      await startList(
        createApi({
          searchQuery,
          subscribeVaultChanged: (callback) => {
            changed = callback;
            return () => {};
          },
        }),
      );
      const dispose = workspace.start();
      try {
        await typeAndSubmit("needle");
        if (hasHit)
          target.querySelector<HTMLButtonElement>('[aria-label="展开 Alpha 的 1 处命中"]')!.click();
        flushSync();
        const occurrence = target.querySelector<HTMLButtonElement>(".occurrence");
        const focused = occurrence ?? searchBox();
        focused.focus();
        // 编辑器正在组词也应立即标记检索过期，不能等正文刷新门禁释放。
        workspace.setComposing(true);
        changed?.({ status: "changed", paths: ["notes/beta.md"], healthy: true });
        flushSync();
        expect(target.querySelector('.results [role="status"]')?.textContent).toContain(
          "笔记库已变化",
        );
        expect(searchQuery).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(focused);
        expect(target.querySelector(".occurrence")).toBe(occurrence);
        expect(searchBox().value).toBe("needle");
        workspace.setComposing(false);
        await settle();
        flushSync();
        await vi.waitFor(() => {
          flushSync();
          expect(target.querySelector('.results [role="status"]')?.textContent).toContain(
            "共 1 篇",
          );
          expect(searchQuery).toHaveBeenCalledTimes(2);
        });
        expect(searchQuery).toHaveBeenCalledTimes(2);
        expect(document.activeElement).toBe(focused);
        if (hasHit) expect(target.querySelector(".occurrence")).toBe(occurrence);
      } finally {
        dispose();
      }
    },
  );

  it("解析失败在结果区显示原因并保留输入焦点，修正查询后可继续搜索", async () => {
    const searchQuery = vi.fn(async () => ({ hits: [], nextCursor: null }));
    await startList(createApi({ searchQuery }));
    searchBox().focus();
    await typeAndSubmit(`${"-".repeat(SEARCH_DEPTH_LIMIT + 1)}alpha`);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("检索条件嵌套过深");
    expect(target.querySelector('[role="tree"]')).toBeNull();
    expect(document.activeElement).toBe(searchBox());
    expect(searchQuery).not.toHaveBeenCalled();

    await typeAndSubmit("alpha");
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("共 0 篇");
    expect(target.querySelector(".empty")?.textContent).toContain("没有匹配的笔记");
  });

  it("单篇按需加载保留精确总数、已有节点和键盘位置，直到真实末页", async () => {
    const matches = Array.from({ length: 26 }, (_, i) => ({
      snippet: `命中 ${i + 1}`,
      location: { startByte: i * 10, endByte: i * 10 + 6, line: i + 1 },
    }));
    const hit: SearchHit = {
      path: "alpha.md",
      title: "Alpha",
      snippet: matches[0]!.snippet,
      contentHash: "a".repeat(64),
      matches: matches.slice(0, 5),
      matchCount: 26,
      matchesCursor: "first-more",
    };
    const searchMatches = vi
      .fn<ReaderApi["searchMatches"]>()
      .mockResolvedValueOnce({ matches: matches.slice(5, 25), nextCursor: "last" })
      .mockResolvedValueOnce({ matches: matches.slice(25), nextCursor: null });
    await startList(
      createApi({ searchQuery: async () => ({ hits: [hit], nextCursor: null }), searchMatches }),
    );
    const open = vi.spyOn(workspace.navigation, "openSearchMatch").mockResolvedValue();
    await typeAndSubmit("needle");
    target.querySelector<HTMLButtonElement>('[aria-label="展开 Alpha 的 26 处命中"]')!.click();
    flushSync();
    expect(target.querySelectorAll(".occurrence")).toHaveLength(5);
    expect(searchMatches).not.toHaveBeenCalled();
    const first = target.querySelector(".occurrence");
    const more = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("还有 21 处"),
    )!;
    more.focus();
    more.click();
    more.click();
    await settle();
    flushSync();
    expect(searchMatches).toHaveBeenCalledTimes(1);
    expect(target.querySelectorAll(".occurrence")).toHaveLength(25);
    expect(target.querySelector(".occurrence")).toBe(first);
    expect(document.activeElement).toBe(target.querySelectorAll(".occurrence")[5]);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("共 1 篇 · 26 处命中");
    const last = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("还有 1 处"),
    )!;
    last.click();
    await settle();
    flushSync();
    expect(target.querySelectorAll(".occurrence")).toHaveLength(26);
    expect(
      [...target.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("显示更多"),
      ),
    ).toBe(false);
    target.querySelectorAll<HTMLButtonElement>(".occurrence")[25]!.click();
    await settle();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ matchCount: 26 }),
      matches[25],
      workspace.openFile,
      expect.any(Function),
    );
  });

  it("命中续页失效只在该笔记显示原因，并保留原来的五处命中", async () => {
    const matches = Array.from({ length: 5 }, (_, i) => ({
      snippet: "needle",
      location: { startByte: i * 7, endByte: i * 7 + 6, line: i + 1 },
    }));
    const hit: SearchHit = {
      path: "alpha.md",
      title: "Alpha",
      snippet: "needle",
      contentHash: "a".repeat(64),
      matches,
      matchCount: 26,
      matchesCursor: "more",
    };
    await startList(
      createApi({
        searchQuery: async () => ({ hits: [hit], nextCursor: null }),
        searchMatches: async () => {
          throw new Error("笔记库已更新，请重新搜索");
        },
      }),
    );
    await typeAndSubmit("needle");
    target.querySelector<HTMLButtonElement>('[aria-label="展开 Alpha 的 26 处命中"]')!.click();
    flushSync();
    [...target.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("显示更多"))!
      .click();
    await settle();
    flushSync();
    expect(target.querySelectorAll(".occurrence")).toHaveLength(5);
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("笔记库已更新");
    expect(
      [...target.querySelectorAll("button")].some((button) => button.textContent === "重新搜索"),
    ).toBe(true);
  });
  it("续页追加保留已有节点，并将加载按钮的焦点交给第一条新增命中", async () => {
    const hit = (path: string): SearchHit => ({
      path,
      title: path,
      contentHash: "a".repeat(64),
      matches: [],
      snippet: "",
      matchCount: 0,
      matchesCursor: null,
    });
    const searchQuery = vi
      .fn<ReaderApi["searchQuery"]>()
      .mockResolvedValueOnce({ hits: [hit("alpha.md")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ hits: [hit("notes/beta.md")], nextCursor: null });
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("alpha");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("已显示 1 篇");
    const first = target.querySelector(".hit");
    const more = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "加载更多结果",
    )!;
    more.focus();
    more.click();
    await settle();
    flushSync();
    expect(target.querySelectorAll(".hit")).toHaveLength(2);
    expect(target.querySelector(".hit")).toBe(first);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("共 2 篇");
    expect(document.activeElement).toBe(target.querySelectorAll(".hit")[1]);
  });

  it("按文件展开真实命中，选择第二处时传递其范围并保留结果", async () => {
    const matches = [
      { snippet: "第一处\u0001预算\u0002", location: { startByte: 10, endByte: 16, line: 3 } },
      { snippet: "第二处\u0001预算\u0002", location: { startByte: 30, endByte: 36, line: 8 } },
    ];
    const hit: SearchHit = {
      path: "alpha.md",
      title: "Alpha",
      snippet: matches[0]!.snippet,
      contentHash: "a".repeat(64),
      matches,
      matchCount: matches.length,
      matchesCursor: null,
    };
    await startList(createApi({ searchQuery: async () => ({ hits: [hit], nextCursor: null }) }));
    const open = vi.spyOn(workspace.navigation, "openSearchMatch").mockResolvedValue();
    await typeAndSubmit("预算");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("1 篇 · 2 处");
    target.querySelector<HTMLButtonElement>('[aria-label="展开 Alpha 的 2 处命中"]')!.click();
    flushSync();
    const occurrences = target.querySelectorAll<HTMLButtonElement>(".occurrence");
    expect(occurrences.length).toBe(2);
    expect(occurrences[1]?.textContent).toContain("第 8 行");
    occurrences[1]!.click();
    await settle();
    expect(open).toHaveBeenCalledWith(hit, matches[1], workspace.openFile, expect.any(Function));
    expect(target.querySelectorAll(".occurrence").length).toBe(2);
  });
  it.each(["标签", "书签", "过滤", "全文"])(
    "从%s返回时保留完整目录的滚动与展开状态",
    async (mode) => {
      await startList(createApi());
      target.querySelector<HTMLButtonElement>('[data-path="notes"]')!.click();
      flushSync();
      const tree = target.querySelector<HTMLUListElement>('[role="tree"]')!;
      // 锚点必须落在真实行内；jsdom 不会像浏览器一样夹住越界的 scrollTop。
      tree.scrollTop = 72;
      tree.dispatchEvent(new Event("scroll"));
      flushSync();
      if (mode === "标签" || mode === "书签") {
        const button = target.querySelector<HTMLButtonElement>(
          `[aria-label="${mode === "标签" ? "浏览标签" : "书签"}"]`,
        )!;
        button.click();
        flushSync();
        button.click();
      } else {
        searchBox().value = "alpha";
        searchBox().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(tree.scrollTop).toBe(0);
        if (mode === "全文") await typeAndSubmit("alpha");
        target.querySelector<HTMLButtonElement>('[aria-label="清除搜索"]')!.click();
      }
      flushSync();
      expect(target.querySelector<HTMLUListElement>('[role="tree"]')!.scrollTop).toBe(72);
      expect(target.querySelector('[data-path="notes"]')?.getAttribute("aria-expanded")).toBe(
        "true",
      );
    },
  );

  it.each(["标签", "书签", "搜索"])("从%s定位当前文件时切回完整目录并交还焦点", async (mode) => {
    await startList(createApi());
    await workspace.openFile("notes/beta.md");
    flushSync();
    if (mode === "搜索") await typeAndSubmit("正文");
    else {
      target
        .querySelector<HTMLButtonElement>(
          `[aria-label="${mode === "标签" ? "浏览标签" : "书签"}"]`,
        )!
        .click();
      flushSync();
    }
    target.querySelector<HTMLButtonElement>('[aria-label="文件管理"]')!.click();
    await settle();
    [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === "定位当前文件")!
      .click();
    await settle();
    flushSync();
    expect(searchBox().value).toBe("");
    expect(workspace.search.active).toBe(false);
    const row = target.querySelector('[data-path="notes/beta.md"]');
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("选择侧栏模式时退出全文结果，输入新查询时立即过滤文件", async () => {
    await startList(createApi());
    await typeAndSubmit("正文");
    target.querySelector<HTMLButtonElement>('[aria-label="浏览标签"]')!.click();
    flushSync();
    expect(workspace.search.active).toBe(false);
    expect(searchBox().value).toBe("");
    const input = searchBox();
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelector('[data-path="notes/beta.md"]')).not.toBeNull();
    expect(target.querySelector('[data-path="alpha.md"]')).toBeNull();
    await typeAndSubmit("正文");
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(workspace.search.active).toBe(false);
    expect(target.querySelector('[data-path="alpha.md"]')).not.toBeNull();
  });

  it("文件操作完成后从书签面板回到条目所在目录", async () => {
    await startList(createApi());
    await component.showBookmarks();
    await component.reflectChange(
      { action: "create", entry: { path: "notes", kind: "directory" } },
      true,
    );
    flushSync();
    expect(document.activeElement).toBe(target.querySelector('[data-path="notes"]'));
    expect(target.querySelector('[aria-label="书签"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("文件树的输入法按键不触发重命名，删除快捷键进入确认流程", async () => {
    await startList(createApi());
    const row = target.querySelector<HTMLButtonElement>('[data-path="alpha.md"]')!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    flushSync();
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", isComposing: true, bubbles: true }),
    );
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", keyCode: 229, bubbles: true }));
    expect(onEdit).not.toHaveBeenCalled();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(onEdit).toHaveBeenLastCalledWith(
      "trash",
      expect.objectContaining({ path: "alpha.md" }),
      "",
    );
    onEdit.mockClear();
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true }),
    );
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenLastCalledWith(
      "trash",
      expect.objectContaining({ path: "alpha.md" }),
      "",
    );
  });

  it("回车提交检索，结果列表替换文件树并高亮命中词", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [
        {
          path: "notes/beta.md",
          title: "Beta",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "前文\u{1}hit word\u{2}后文",
          matchCount: 0,
          matchesCursor: null,
        },
      ],
      nextCursor: null,
    }));
    await startList(createApi({ searchQuery }));
    expect(target.querySelectorAll(".file").length).toBeGreaterThan(0);

    await typeAndSubmit("hit word");

    expect(searchQuery).toHaveBeenCalledWith(
      {
        kind: "hybrid",
        text: "hit word",
        filter: { kind: "and", children: [] },
        limit: 100,
      },
      expect.any(String),
      null,
    );
    expect(target.querySelector('[role="treeitem"]')).toBeNull();
    const hit = target.querySelector<HTMLButtonElement>(".hit");
    expect(hit).not.toBeNull();
    expect(hit?.querySelector(".title")?.textContent).toBe("Beta");
    expect(hit?.querySelector(".path")?.textContent).toBe("notes/beta.md");
    expect(hit?.querySelector("mark")?.textContent).toBe("hit word");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("共 1 篇");
  });

  it("点击命中打开文件并通知外壳完成导航", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [
        {
          path: "notes/beta.md",
          title: "Beta",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "\u{1}hit\u{2}",
          matchCount: 0,
          matchesCursor: null,
        },
      ],
      nextCursor: null,
    }));
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("hit");

    target.querySelector<HTMLButtonElement>(".hit")!.click();
    await settle();
    flushSync();

    expect(workspace.document.path).toBe("notes/beta.md");
    expect(onOpen).toHaveBeenCalled();
    // 结果保持展示，命中标记跟随当前文档。
    expect(target.querySelector(".hit.active")).not.toBeNull();
  });

  it("检索失败展示原因，不回到文件树", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => {
      throw new Error("索引损坏");
    });
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("alpha");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("搜索失败");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("索引损坏");
    expect(target.querySelector(".hit")).toBeNull();
  });

  it("空结果展示引导文案", async () => {
    await startList(createApi());
    await typeAndSubmit("absent");
    expect(target.querySelector(".empty")?.textContent).toContain("没有匹配的笔记");
  });

  it("Escape 退出结果模式保留过滤词，清除按钮同时清空查询", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [
        {
          path: "alpha.md",
          title: "Alpha",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "",
          matchCount: 0,
          matchesCursor: null,
        },
      ],
      nextCursor: null,
    }));
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("alpha");
    expect(target.querySelector(".hit")).not.toBeNull();

    searchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(target.querySelector(".hit")).toBeNull();
    expect(target.querySelector('[role="treeitem"]')).not.toBeNull();
    expect(searchBox().value).toBe("alpha");

    await typeAndSubmit("alpha");
    target.querySelector<HTMLButtonElement>(".clear-search")!.click();
    flushSync();
    expect(target.querySelector(".hit")).toBeNull();
    expect(searchBox().value).toBe("");
  });

  it("ArrowDown 从搜索框进入结果列表，Escape 在列表内也能退出", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [
        {
          path: "alpha.md",
          title: "Alpha",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "",
          matchCount: 0,
          matchesCursor: null,
        },
        {
          path: "notes/beta.md",
          title: "Beta",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "",
          matchCount: 0,
          matchesCursor: null,
        },
      ],
      nextCursor: null,
    }));
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("a");

    searchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    const first = target.querySelector<HTMLButtonElement>('.hit[data-index="0"]');
    expect(document.activeElement).toBe(first);

    first!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    expect(document.activeElement).toBe(target.querySelector('.hit[data-index="1"]'));

    target
      .querySelector<HTMLButtonElement>('.hit[data-index="1"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(target.querySelector('[role="treeitem"]')).not.toBeNull();
    expect(document.activeElement).toBe(searchBox());
  });

  it("标签面板组树展示，点击标签进入 tag: 检索", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({
      hits: [
        {
          path: "notes/beta.md",
          title: "Beta",
          contentHash: "a".repeat(64),
          matches: [],
          snippet: "",
          matchCount: 0,
          matchesCursor: null,
        },
      ],
      nextCursor: null,
    }));
    const indexTags = vi.fn(async () => [
      { tag: "project", count: 2 },
      { tag: "project/noemori", count: 1 },
    ]);
    await startList(createApi({ searchQuery, indexTags }));

    target.querySelector<HTMLButtonElement>('[aria-label="浏览标签"]')!.click();
    flushSync();
    await settle();
    flushSync();

    const names = [...target.querySelectorAll(".tag .name")].map((node) => node.textContent);
    expect(names).toEqual(["#project", "#noemori"]);
    // 文件树的行让位给标签面板（文件树行带 data-path，标签行没有）。
    expect(target.querySelector('[role="treeitem"][data-path]')).toBeNull();

    // 点击子标签：转成 tag: 谓词检索并展示结果。
    const child = [...target.querySelectorAll<HTMLButtonElement>(".tag")].find((button) =>
      button.textContent?.includes("noemori"),
    );
    child!.click();
    await settle();
    flushSync();
    expect(searchQuery).toHaveBeenCalledWith(
      {
        expr: { kind: "tag", value: "project/noemori" },
        limit: 100,
      },
      expect.any(String),
      null,
    );
    expect(searchBox().value).toBe("tag:project/noemori");
    expect(target.querySelector(".hit")).not.toBeNull();
  });

  it("谓词查询进入结构化条件，纯空白回车不发起检索", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchPage> => ({ hits: [], nextCursor: null }));
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("tag:keep status:draft path:notes/ (a OR -b)");
    expect(searchQuery).toHaveBeenCalledWith(
      {
        expr: {
          kind: "and",
          children: [
            { kind: "tag", value: "keep" },
            { kind: "attr", key: "status", value: "draft" },
            { kind: "path", value: "notes/" },
            {
              kind: "or",
              children: [
                { kind: "term", value: "a" },
                { kind: "not", child: { kind: "term", value: "b" } },
              ],
            },
          ],
        },
        limit: 100,
      },
      expect.any(String),
      null,
    );

    await typeAndSubmit("   ");
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="treeitem"]')).not.toBeNull();
  });
});
