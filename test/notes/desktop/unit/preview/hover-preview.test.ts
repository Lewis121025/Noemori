/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  createHoverController,
  previewRequestOf,
  previewTargetOf,
} from "@reader/renderer/preview/hover-preview";

describe("悬停状态机", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const show = vi.fn();
    const hide = vi.fn();
    return { show, hide, hover: createHoverController<string>({ show, hide }) };
  }

  it("停留满延迟才打开，提前离开不打开", () => {
    const { show, hover } = setup();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS - 1);
    hover.leaveLink();
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    expect(show).not.toHaveBeenCalled();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    expect(show).toHaveBeenCalledWith("a");
  });

  it("离开链接后短暂延迟关闭，移入弹层保持打开，移出弹层再关闭", () => {
    const { show, hide, hover } = setup();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    hover.leaveLink();
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 1);
    hover.enterPopover();
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 2);
    expect(hide).not.toHaveBeenCalled();
    hover.leavePopover();
    vi.advanceTimersByTime(HOVER_CLOSE_MS);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("回到同一链接不重复打开；换到另一链接重新计时", () => {
    const { show, hover } = setup();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    hover.leaveLink();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS * 2);
    expect(show).toHaveBeenCalledTimes(1);
    hover.enterLink("b");
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    expect(show).toHaveBeenLastCalledWith("b");
  });

  it("dismiss 立即关闭并取消待定打开", () => {
    const { show, hide, hover } = setup();
    hover.enterLink("a");
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    hover.dismiss();
    expect(hide).toHaveBeenCalledTimes(1);
    hover.enterLink("b");
    hover.dismiss();
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe("悬停目标识别", () => {
  function element(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.querySelector("[data-test]")!;
  }

  it("识别 wiki、库内 Markdown 链接与已解析路径，忽略外链与弹层内部", () => {
    expect(
      previewTargetOf(
        element('<span class="wiki-link" data-wiki-target="笔记#小节"><b data-test>x</b></span>'),
      ),
    ).toMatchObject({ target: { kind: "wiki", raw: "笔记#小节" } });
    expect(previewTargetOf(element('<a href="dir/a.md#h%20x" data-test>a</a>'))).toMatchObject({
      target: { kind: "md", raw: "dir/a.md#h%20x" },
    });
    expect(
      previewTargetOf(element('<button data-preview-path="n/b.md" data-test>b</button>')),
    ).toMatchObject({
      target: { kind: "wiki", raw: "n/b.md" },
    });
    expect(previewTargetOf(element('<a href="https://example.com" data-test>x</a>'))).toBeNull();
    expect(
      previewTargetOf(element('<div class="hover-preview"><a href="a.md" data-test>a</a></div>')),
    ).toBeNull();
    expect(previewTargetOf(element("<p data-test>普通文字</p>"))).toBeNull();
  });

  it("目标拆出锚点，Markdown 锚点按 URL 解码，纯锚点指向宿主自身", () => {
    expect(previewRequestOf({ kind: "wiki", raw: "笔记#小节" }, "host.md")).toEqual({
      kind: "wiki",
      target: "笔记",
      anchor: "小节",
    });
    expect(previewRequestOf({ kind: "md", raw: "a.md#h%20x" }, "host.md")).toEqual({
      kind: "md",
      target: "a.md",
      anchor: "h x",
    });
    expect(previewRequestOf({ kind: "wiki", raw: "#^blk" }, "dir/host.md")).toEqual({
      kind: "wiki",
      target: "dir/host.md",
      anchor: "^blk",
    });
    expect(previewRequestOf({ kind: "wiki", raw: "整篇" }, "host.md").anchor).toBeNull();
  });
});
