/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "@reader/renderer/graph/GraphPanel.svelte";
import { createInlineLayout } from "@reader/renderer/graph/layout-client";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { GraphNode, VaultGraph } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const node = (path: string, tags: string[] = []): GraphNode => ({
  path,
  title: path.replace(/\.md$/u, ""),
  tags,
  dead: false,
});
const base: VaultGraph = {
  nodes: [node("a.md", ["项目"]), node("b.md"), node("c.md"), node("孤立.md")],
  edges: [
    { from: "a.md", to: "b.md", count: 1 },
    { from: "b.md", to: "c.md", count: 2 },
  ],
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

beforeEach(() => {
  // jsdom 不提供系统外观监听；图谱主题的实际变化由 Electron 用例覆盖。
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
  // jsdom 没有 Canvas；绘制在 Electron 用例覆盖，这里只验证数据流。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(center: string | null, graph: VaultGraph = base) {
  const indexGraph = vi.fn(async (includeDead: boolean) =>
    includeDead
      ? {
          nodes: [...graph.nodes, { ...node("未写"), dead: true }],
          edges: [...graph.edges, { from: "a.md", to: "未写", count: 1 }],
        }
      : graph,
  );
  const api = createReaderApiMock({ indexGraph });
  const workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  const onOpen = vi.fn();
  component = mount(GraphPanel, {
    target,
    props: { workspace, center, engine: createInlineLayout(), onOpen },
  });
  await settle();
  flushSync();
  return { api, workspace, onOpen, indexGraph };
}

const stats = () => target.querySelector(".stats")?.textContent;
const input = () => target.querySelector<HTMLInputElement>('input[type="search"]')!;
const checkbox = (label: string) =>
  [...target.querySelectorAll("label")]
    .find((element) => element.textContent?.includes(label))
    ?.querySelector<HTMLInputElement>("input")!;

describe("全局图谱面板", () => {
  it("读入全库图谱，过滤、孤立开关与死链开关分别作用于显示的节点", async () => {
    const { indexGraph } = await start(null);
    expect(indexGraph).toHaveBeenLastCalledWith(false);
    expect(stats()).toBe("4 个节点 · 2 条链接");

    input().value = "tag:项目";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(stats()).toBe("1 个节点 · 0 条链接");

    input().value = "";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    checkbox("孤立笔记").click();
    flushSync();
    expect(stats()).toBe("3 个节点 · 2 条链接");

    checkbox("未创建的笔记").click();
    await settle();
    flushSync();
    expect(indexGraph).toHaveBeenLastCalledWith(true);
    expect(stats()).toBe("4 个节点 · 3 条链接");
  });

  it("回车打开过滤结果的第一篇", async () => {
    const { onOpen } = await start(null);
    input().value = "c";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith(node("c.md"));
  });

  it("库变更后防抖重读；结果未变时不替换图", async () => {
    const { workspace, indexGraph } = await start(null);
    vi.useFakeTimers();
    await workspace.refreshList();
    await workspace.refreshList();
    flushSync();
    expect(indexGraph).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(indexGraph).toHaveBeenCalledTimes(2);
  });

  it("读取失败时就地显示原因", async () => {
    const api = createReaderApiMock({
      indexGraph: vi.fn(async () => {
        throw new Error("索引损坏");
      }),
    });
    const workspace = new ReaderWorkspaceController(api);
    target = document.createElement("div");
    document.body.append(target);
    component = mount(GraphPanel, {
      target,
      props: { workspace, center: null, engine: createInlineLayout(), onOpen: vi.fn() },
    });
    await settle();
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("索引损坏");
  });
});

describe("局部图谱面板", () => {
  it("以当前笔记为中心按深度扩展；孤立开关不会隐藏中心自身", async () => {
    await start("a.md");
    expect(stats()).toBe("2 个节点 · 1 条链接");
    const depth = target.querySelector<HTMLSelectElement>('select[aria-label="局部图谱深度"]')!;
    depth.value = "2";
    depth.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(stats()).toBe("3 个节点 · 2 条链接");
  });

  it("孤立的中心仍然显示", async () => {
    await start("孤立.md");
    checkbox("孤立笔记").click();
    flushSync();
    expect(stats()).toBe("1 个节点 · 0 条链接");
  });
});
