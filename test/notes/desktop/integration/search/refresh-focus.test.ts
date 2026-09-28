/** @vitest-environment jsdom */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import SearchResults from "@reader/renderer/search/SearchResults.svelte";
import { ReaderSearch } from "@reader/renderer/search/state.svelte";
import type { SearchHit, SearchPage } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const hit = (path: string): SearchHit => ({
  path,
  title: path,
  snippet: "",
  contentHash: "a".repeat(64),
  matches: [],
  matchCount: 0,
  matchesCursor: null,
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
});

async function setup(pages: SearchPage[]) {
  const searchQuery = vi.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error("缺少测试页面");
    return page;
  });
  const search = new ReaderSearch(createReaderApiMock({ searchQuery }), vi.fn());
  const host = document.createElement("div");
  const input = document.createElement("input");
  const target = document.createElement("div");
  host.append(input, target);
  document.body.append(host);
  const component = mount(SearchResults, {
    target,
    props: {
      search,
      activePath: null,
      onActivate: () => {},
      onExit: () => {},
      onFocusSearch: () => input.focus(),
    },
  });
  cleanup.push(async () => {
    search.reset();
    await unmount(component);
    host.remove();
  });
  await search.run("needle");
  flushSync();
  return { search, target, input };
}

it("自动刷新保留第 105 条结果及其键盘焦点", async () => {
  vi.useFakeTimers();
  const hits = Array.from({ length: 105 }, (_, i) => hit(`${i}.md`));
  const { search, target } = await setup([
    { hits: hits.slice(0, 100), nextCursor: "old-next" },
    { hits: hits.slice(100), nextCursor: null },
    { hits: hits.slice(0, 100), nextCursor: "new-next" },
    { hits: hits.slice(100), nextCursor: null },
  ]);
  await search.loadMore();
  flushSync();
  target.querySelector<HTMLButtonElement>('[title="104.md"]')!.focus();
  flushSync();
  search.markStale();
  await vi.advanceTimersByTimeAsync(250);
  flushSync();
  await tick();
  expect(target.querySelectorAll(".hit")).toHaveLength(105);
  expect(document.activeElement?.getAttribute("title")).toBe("104.md");
  expect(target.querySelector('.hit[tabindex="0"]')?.getAttribute("title")).toBe("104.md");
});

it("结果重排时 Tab 入口跟随文件身份，不沿用旧数组下标", async () => {
  const { search, target } = await setup([
    { hits: [hit("a"), hit("b"), hit("c")], nextCursor: null },
    { hits: [hit("b"), hit("c"), hit("a")], nextCursor: null },
  ]);
  target.querySelector<HTMLButtonElement>('[title="b"]')!.focus();
  flushSync();
  await search.refresh();
  flushSync();
  await tick();
  expect(document.activeElement?.getAttribute("title")).toBe("b");
  expect(target.querySelector('.hit[tabindex="0"]')?.getAttribute("title")).toBe("b");
});

it.each([false, true])("目标被删除时选择相邻文件，结果清空（%s）时回到查询框", async (empty) => {
  const { search, target, input } = await setup([
    { hits: [hit("a"), hit("b"), hit("c")], nextCursor: null },
    { hits: empty ? [] : [hit("a"), hit("c")], nextCursor: null },
  ]);
  target.querySelector<HTMLButtonElement>('[title="b"]')!.focus();
  flushSync();
  await search.refresh();
  flushSync();
  await tick();
  if (empty) expect(document.activeElement).toBe(input);
  else {
    expect(document.activeElement?.getAttribute("title")).toBe("c");
    expect(target.querySelector('.hit[tabindex="0"]')?.getAttribute("title")).toBe("c");
  }
});

it("焦点已离开结果列表时，后台刷新不能抢回", async () => {
  const { search, target, input } = await setup([
    { hits: [hit("a"), hit("b")], nextCursor: null },
    { hits: [hit("a")], nextCursor: null },
  ]);
  target.querySelector<HTMLButtonElement>('[title="b"]')!.focus();
  flushSync();
  input.focus();
  await search.refresh();
  flushSync();
  await tick();
  expect(document.activeElement).toBe(input);
  expect(target.querySelectorAll('.hit[tabindex="0"]')).toHaveLength(1);
});

it("正文版本变化后，同一命中序号不能冒充旧目标，焦点退回所属文件", async () => {
  const first = { ...hit("a"), matchCount: 1, matches: [{ snippet: "旧命中", location: null }] };
  const next = {
    ...first,
    contentHash: "b".repeat(64),
    matches: [{ snippet: "新命中", location: null }],
  };
  const { search, target } = await setup([
    { hits: [first], nextCursor: null },
    { hits: [next], nextCursor: null },
  ]);
  target.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click();
  flushSync();
  target.querySelector<HTMLButtonElement>(".occurrence")!.focus();
  flushSync();
  await search.refresh();
  flushSync();
  await tick();
  expect(document.activeElement).toBe(target.querySelector(".hit"));
  expect(target.querySelector(".occurrence")?.textContent).toContain("新命中");
});

it("库变化正在刷新时保留加载按钮的焦点，避免尚未发布就失去键盘位置", async () => {
  const { search, target } = await setup([{ hits: [hit("a")], nextCursor: "next" }]);
  const more = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "加载更多结果",
  )!;
  more.focus();
  search.markStale();
  flushSync();
  await tick();
  expect(document.activeElement).toBe(more);
  expect(more.getAttribute("aria-disabled")).toBe("true");
});
