import { describe, expect, it } from "vitest";
import { ReaderHistory } from "@reader/renderer/navigation/history.svelte";

const step = (path: string, anchor: string | null = null, scrollTop: number | null = null) => ({
  path,
  anchor,
  scrollTop,
});

function attached(scrollTop: number): ReaderHistory {
  const history = new ReaderHistory();
  history.attachScroll({ capture: () => scrollTop, reset: () => {}, apply: () => {} });
  return history;
}

describe("ReaderHistory", () => {
  it("新导航清空前进栈，后退/前进对称移动", () => {
    const history = new ReaderHistory();
    expect(history.canBack).toBe(false);
    history.pushStep(step("a.md"));
    history.pushStep(step("b.md"));
    expect(history.canBack).toBe(true);

    const back = history.peekBack();
    expect(back?.path).toBe("b.md");
    history.commitBack(step("c.md"));
    expect(history.peekBack()?.path).toBe("a.md");
    expect(history.peekForward()?.path).toBe("c.md");

    const forward = history.peekForward();
    history.commitForward(step("a.md", null, 5));
    expect(forward?.path).toBe("c.md");
    expect(history.canForward).toBe(false);
    // 前进把当前位置（a.md）压回后退栈，栈底仍是最早的 a.md。
    expect(history.peekBack()?.path).toBe("a.md");
    expect(history.snapshot().back).toEqual([
      { path: "a.md", anchor: null },
      { path: "a.md", anchor: null },
    ]);

    // 新导航使前进栈失效。
    history.pushStep(step("d.md"));
    expect(history.canForward).toBe(false);
  });

  it("捕获当前条目时带上滚动位置，快照剥离滚动", () => {
    const history = attached(120);
    const captured = history.captureStep({ path: "a.md", anchor: "小节" });
    expect(captured).toEqual({ path: "a.md", anchor: "小节", scrollTop: 120 });
    history.pushStep(captured);
    expect(history.snapshot()).toEqual({
      back: [{ path: "a.md", anchor: "小节" }],
      forward: [],
    });
  });

  it("恢复时按存在性过滤失效条目", () => {
    const history = new ReaderHistory();
    history.restore(
      {
        back: [
          { path: "gone.md", anchor: null },
          { path: "kept.md", anchor: "小节" },
        ],
        forward: [{ path: "gone.md", anchor: null }],
      },
      (path) => path === "kept.md",
    );
    expect(history.snapshot()).toEqual({
      back: [{ path: "kept.md", anchor: "小节" }],
      forward: [],
    });
    expect(history.canForward).toBe(false);
  });

  it("改名跟随路径与目录前缀，删除移除条目", () => {
    const history = new ReaderHistory();
    history.pushStep(step("dir/a.md"));
    history.pushStep(step("dir/sub/b.md", "小节"));
    history.pushStep(step("other.md"));
    history.remapPath("dir", "archive");
    expect(history.snapshot().back.map((entry) => entry.path)).toEqual([
      "archive/a.md",
      "archive/sub/b.md",
      "other.md",
    ]);
    history.remapPath("archive/sub/b.md", null);
    expect(history.snapshot().back.map((entry) => entry.path)).toEqual([
      "archive/a.md",
      "other.md",
    ]);
  });

  it("清空后双栈为空", () => {
    const history = new ReaderHistory();
    history.pushStep(step("a.md"));
    history.clear();
    expect(history.canBack).toBe(false);
    expect(history.canForward).toBe(false);
    expect(history.snapshot()).toEqual({ back: [], forward: [] });
  });

  it("超过上限丢弃最旧条目", () => {
    const history = new ReaderHistory();
    for (let index = 0; index < 150; index += 1) history.pushStep(step(`f${index}.md`));
    const snapshot = history.snapshot();
    expect(snapshot.back).toHaveLength(100);
    expect(snapshot.back[0]?.path).toBe("f50.md");
    expect(snapshot.back.at(-1)?.path).toBe("f149.md");
  });
});
