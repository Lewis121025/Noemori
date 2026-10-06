/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWebPageHost } from "@reader/renderer/preview/webpage-host";
import type { WebPageApi } from "@reader/shared/webpage";

let frames: Map<number, FrameRequestCallback>;
let intersection: ((entries: IntersectionObserverEntry[]) => void) | undefined;
let watched: Set<Element>;

beforeEach(() => {
  frames = new Map();
  watched = new Set();
  intersection = undefined;
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        intersection = callback;
      }
      observe(element: Element) {
        watched.add(element);
      }
      unobserve(element: Element) {
        watched.delete(element);
      }
      disconnect() {
        watched.clear();
      }
    },
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flushFrame(): Promise<void> {
  await Promise.resolve();
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
  await Promise.resolve();
}

function visible(elements: readonly HTMLElement[]): void {
  intersection?.(
    elements.map((target) => ({
      target,
      isIntersecting: true,
      intersectionRatio: 1,
      time: 0,
      rootBounds: null,
      boundingClientRect: new DOMRect(0, 60, 640, 480),
      intersectionRect: new DOMRect(0, 60, 640, 480),
    })),
  );
}

function setup(count: number) {
  const sync = vi.fn<WebPageApi["sync"]>(async () => {});
  const pages = createWebPageHost({ sync, action: async () => {}, subscribe: () => () => {} });
  const container = document.createElement("div");
  container.className = "markdown-content";
  document.body.append(container);
  const hosts: HTMLElement[] = [];
  const handles: ReturnType<typeof pages.mount>[] = [];
  const measured = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function () {
      const index = this.getAttribute("data-page-index");
      return index === null
        ? new DOMRect(0, 0, 1000, 700)
        : new DOMRect(
            10,
            Number(index) < 2 ? 60 + Number(index) * 300 : 2000 + Number(index) * 500,
            640,
            240,
          );
    });
  for (let index = 0; index < count; index++) {
    const host = document.createElement("div");
    host.setAttribute("data-page-index", String(index));
    container.append(host);
    hosts.push(host);
    handles.push(pages.mount(host, `https://example.com/${index}`, () => {}));
  }
  return { sync, hosts, handles, measured, container };
}

it("ProseMirror 先创建节点再挂到正文时，滚动仍能更新网页位置", async () => {
  const sync = vi.fn<WebPageApi["sync"]>(async () => {});
  const pages = createWebPageHost({ sync, action: async () => {}, subscribe: () => () => {} });
  const host = document.createElement("div");
  const handle = pages.mount(host, "https://example.com/", () => {});
  const container = document.createElement("div");
  container.className = "markdown-content";
  container.append(host);
  document.body.append(container);
  const reads = vi
    .spyOn(host, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 60, 640, 480));
  try {
    visible([host]);
    await flushFrame();
    reads.mockClear();
    container.dispatchEvent(new Event("scroll"));
    await flushFrame();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
  } finally {
    handle.destroy();
    await flushFrame();
  }
});

it("500 个网页滚动时，只测量可见网页，布局读取不随离屏节点数量增长", async () => {
  const { hosts, handles, measured, container } = setup(500);
  try {
    visible(hosts.slice(0, 2));
    await flushFrame();
    measured.mockClear();
    container.dispatchEvent(new Event("scroll"));
    await flushFrame();
    const pageReads = measured.mock.contexts.filter((element) =>
      element.hasAttribute("data-page-index"),
    ).length;
    expect(pageReads).toBeLessThanOrEqual(4);
    expect(pageReads).toBeGreaterThan(0);
  } finally {
    for (const handle of handles) handle.destroy();
    await flushFrame();
  }
});

it("侧栏的无关内容变化不触发网页测量，网页自己的状态文本不触发布局循环", async () => {
  const { hosts, handles, measured } = setup(100);
  try {
    visible(hosts.slice(0, 2));
    await flushFrame();
    measured.mockClear();
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    await flushFrame();
    measured.mockClear();
    sidebar.textContent = "无关搜索结果";
    await flushFrame();
    expect(measured.mock.calls.length).toBe(0);
    hosts[0]!.textContent = "正在加载网页…";
    await flushFrame();
    expect(measured.mock.calls.length).toBe(0);
  } finally {
    for (const handle of handles) handle.destroy();
    await flushFrame();
  }
});

it("布局 IPC 在途时合并后续更新，旧请求失败不覆盖新挂载会话", async () => {
  let reject: ((reason: Error) => void) | undefined;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const sync = vi.fn<WebPageApi["sync"]>().mockReturnValueOnce(pending).mockResolvedValue();
  const api = { sync, action: async () => {}, subscribe: () => () => {} };
  const pages = createWebPageHost(api);
  const host = document.createElement("div");
  document.body.append(host);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 640, 480));
  const oldChanged = vi.fn();
  const first = pages.mount(host, "https://example.com/old", oldChanged);
  visible([host]);
  await flushFrame();
  const firstCalls = sync.mock.calls.length;
  first.destroy();
  const newChanged = vi.fn();
  const second = pages.mount(host, "https://example.com/new", newChanged);
  visible([host]);
  await flushFrame();
  expect(sync.mock.calls.length).toBe(firstCalls);
  reject?.(new Error("旧请求失败"));
  await flushFrame();
  expect(newChanged).not.toHaveBeenCalled();
  second.destroy();
  await flushFrame();
});

it("一次卸载两千个节点时分批提交，所有身份都清理且不超过协议上限", async () => {
  const { hosts, handles, sync } = setup(2001);
  visible(hosts.slice(0, 2));
  await flushFrame();
  sync.mockClear();
  for (const handle of handles) handle.destroy();
  for (let round = 0; round < 12; round++) await flushFrame();
  const updates = sync.mock.calls.map(([update]) => update);
  expect(updates.every((update) => update.layouts.length + update.removed.length <= 1000)).toBe(
    true,
  );
  expect(new Set(updates.flatMap((update) => update.removed)).size).toBe(2001);
  expect(watched.size).toBe(0);
});
