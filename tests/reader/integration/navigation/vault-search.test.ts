/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileList from "@reader/renderer/components/files/FileList.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import type { ReaderApi, SearchHit } from "@reader/shared/api";
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
let component: ReturnType<typeof mount>;
let workspace: ReaderWorkspaceController;
let onOpen: ReturnType<typeof vi.fn>;

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
  component = mount(FileList, {
    target,
    props: { workspace, width: 232, onWidth: () => {}, onEdit: () => {}, onOpen },
  });
  await workspace.restore();
  flushSync();
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
  it("回车提交检索，结果列表替换文件树并高亮命中词", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => [
      { path: "notes/beta.md", title: "Beta", snippet: "前文\u{1}hit word\u{2}后文" },
    ]);
    await startList(createApi({ searchQuery }));
    expect(target.querySelectorAll(".file").length).toBeGreaterThan(0);

    await typeAndSubmit("hit word");

    expect(searchQuery).toHaveBeenCalledWith({
      expr: {
        kind: "and",
        children: [
          { kind: "term", value: "hit" },
          { kind: "term", value: "word" },
        ],
      },
      limit: 100,
    });
    expect(target.querySelector('[role="treeitem"]')).toBeNull();
    const hit = target.querySelector<HTMLButtonElement>(".hit");
    expect(hit).not.toBeNull();
    expect(hit?.querySelector(".title")?.textContent).toBe("Beta");
    expect(hit?.querySelector(".path")?.textContent).toBe("notes/beta.md");
    expect(hit?.querySelector("mark")?.textContent).toBe("hit word");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("共 1 条结果");
  });

  it("点击命中打开文件并通知外壳完成导航", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => [
      { path: "notes/beta.md", title: "Beta", snippet: "\u{1}hit\u{2}" },
    ]);
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
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => {
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
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => [
      { path: "alpha.md", title: "Alpha", snippet: "" },
    ]);
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
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => [
      { path: "alpha.md", title: "Alpha", snippet: "" },
      { path: "notes/beta.md", title: "Beta", snippet: "" },
    ]);
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
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => [
      { path: "notes/beta.md", title: "Beta", snippet: "" },
    ]);
    const indexTags = vi.fn(async () => [
      { tag: "project", count: 2 },
      { tag: "project/nous", count: 1 },
    ]);
    await startList(createApi({ searchQuery, indexTags }));

    target.querySelector<HTMLButtonElement>('[aria-label="浏览标签"]')!.click();
    flushSync();
    await settle();
    flushSync();

    const names = [...target.querySelectorAll(".tag .name")].map((node) => node.textContent);
    expect(names).toEqual(["#project", "#nous"]);
    // 文件树的行让位给标签面板（文件树行带 data-path，标签行没有）。
    expect(target.querySelector('[role="treeitem"][data-path]')).toBeNull();

    // 点击子标签：转成 tag: 谓词检索并展示结果。
    const child = [...target.querySelectorAll<HTMLButtonElement>(".tag")].find((button) =>
      button.textContent?.includes("nous"),
    );
    child!.click();
    await settle();
    flushSync();
    expect(searchQuery).toHaveBeenCalledWith({
      expr: { kind: "tag", value: "project/nous" },
      limit: 100,
    });
    expect(searchBox().value).toBe("tag:project/nous");
    expect(target.querySelector(".hit")).not.toBeNull();
  });

  it("谓词查询进入结构化条件，纯空白回车不发起检索", async () => {
    const searchQuery = vi.fn(async (): Promise<SearchHit[]> => []);
    await startList(createApi({ searchQuery }));
    await typeAndSubmit("tag:keep status:draft path:notes/ (a OR -b)");
    expect(searchQuery).toHaveBeenCalledWith({
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
    });

    await typeAndSubmit("   ");
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="treeitem"]')).not.toBeNull();
  });
});
