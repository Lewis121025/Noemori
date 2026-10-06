/** @vitest-environment jsdom */
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, expect, it, vi } from "vitest";
import { createOutlinePosition } from "@reader/renderer/editor/outline-position";
import { parseMarkdown } from "@reader/shared/markdown/parse";

afterEach(() => vi.restoreAllMocks());

function fixture(source: string) {
  const doc = parseMarkdown(source);
  const scroller = document.createElement("div");
  scroller.className = "main";
  document.body.append(scroller);
  const view = new EditorView(scroller, { state: EditorState.create({ doc }) });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 800, 600));
  return {
    view,
    index: createOutlinePosition(doc),
    close() {
      view.destroy();
      scroller.remove();
    },
  };
}

it("长文目录只作对数次几何查询，文首、分界与末尾仍定位正确", () => {
  const test = fixture(
    Array.from({ length: 1024 }, (_, index) => `## 第 ${index} 节\n\n正文\n`).join("\n"),
  );
  let top = 0;
  let reads = 0;
  try {
    for (const [index, item] of test.index.items.entries()) {
      const node = test.view.nodeDOM(item.pos);
      if (!(node instanceof HTMLElement)) throw new Error("缺少标题节点");
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
        reads += 1;
        return new DOMRect(0, index * 100 - top, 400, 30);
      });
    }
    for (const [scroll, expected] of [
      [-200, 0],
      [123, 2],
      [124, 2],
      [776, 9],
      [200000, 1023],
    ]) {
      top = scroll!;
      reads = 0;
      expect(test.index.visibleHeading(test.view)).toBe(test.index.items[expected!]!.pos);
      expect(reads).toBeLessThanOrEqual(11);
    }
  } finally {
    test.close();
  }
});

it("嵌套标题保留几何顺序查询，不对多列容器假定源码顺序等于垂直顺序", () => {
  const test = fixture("# 开头\n\n> ## 嵌套一\n>\n> ## 嵌套二\n\n## 结尾\n");
  try {
    const tops = [0, 300, 50, 500];
    for (const [index, item] of test.index.items.entries()) {
      const node = test.view.nodeDOM(item.pos);
      if (!(node instanceof HTMLElement)) throw new Error("缺少标题节点");
      vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, tops[index]!, 400, 30),
      );
    }
    expect(test.index.visibleHeading(test.view)).toBe(test.index.items[2]!.pos);
  } finally {
    test.close();
  }
});

it("空目录返回 null，编辑后的索引使用新标题位置", () => {
  const test = fixture("正文\n");
  try {
    expect(test.index.visibleHeading(test.view)).toBeNull();
    const doc = parseMarkdown("# 新标题\n\n正文\n");
    test.view.updateState(EditorState.create({ doc }));
    expect(createOutlinePosition(doc).visibleHeading(test.view)).toBe(0);
  } finally {
    test.close();
  }
});
