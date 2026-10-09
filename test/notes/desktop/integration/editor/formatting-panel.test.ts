/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import Harness from "./EditorFormattingHarness.svelte";

it("编辑工具栏常驻，随选区更新格式状态，应用命令后仍保持可用", async () => {
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("正文") }),
    handleScrollToSelection: () => true,
  });
  const state = writable(view.state);
  const app = mount(Harness, { target, props: { view, state } });
  try {
    flushSync();
    expect(target.querySelector('[role="toolbar"][aria-label="编辑工具栏"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="更多编辑操作"]')).toBeNull();
    const insert = target.querySelector('button[aria-label="插入"]');
    expect(insert).not.toBeNull();
    expect(insert?.closest("[popover]")).toBeNull();
    expect(target.querySelector('[role="menu"][aria-label="标注"]')).toBeNull();
    for (const label of ["链接…", "插入附件…"]) {
      expect(target.querySelector(`[aria-label="${label}"]`)?.closest('[role="menu"]')?.getAttribute("aria-label")).toBe("插入");
    }
    expect(target.querySelector('button[aria-label="表格"]')).toBeNull();
    expect([...target.querySelectorAll('.marks > button')].map(button => button.getAttribute("aria-label")))
      .toEqual(["加粗", "斜体", "下划线", "删除线", "行内代码", "文字颜色", "高亮", "清除文字样式"]);
    for (const label of ["引用", "撤销", "重做"]) {
      const button = target.querySelector(`[aria-label="${label}"]`);
      expect(button, label).not.toBeNull();
      expect(button?.closest("[popover]")).toBeNull();
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    state.set(view.state);
    flushSync();
    const bold = target.querySelector<HTMLButtonElement>('[aria-label="加粗"]')!;
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    bold.click();
    state.set(view.state);
    flushSync();
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(view.state.doc.textContent).toBe("正文");
    expect(target.querySelector('[aria-label="表格…"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="插入附件…"]')).not.toBeNull();
  } finally {
    await unmount(app);
    view.destroy();
    host.remove();
    target.remove();
    vi.restoreAllMocks();
  }
});

it("列表类型与引用状态随完整选区更新，混合选区不伪装成统一格式", async () => {
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const doc = parseMarkdown("- [x] 任务项\n- 普通项\n\n> 引用段\n\n正文段\n");
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.isText) positions.set(node.textContent, pos);
  });
  const view = new EditorView(host, {
    state: EditorState.create({ doc }),
    handleScrollToSelection: () => true,
  });
  const state = writable(view.state);
  const app = mount(Harness, { target, props: { view, state } });
  const select = (first: string, last = first): void => {
    const from = positions.get(first);
    const to = positions.get(last);
    if (from === undefined || to === undefined) throw new Error("测试选区必须存在于正文中");
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to + last.length)),
    );
    state.set(view.state);
    flushSync();
  };
  try {
    select("任务项");
    expect(target.querySelector('[aria-label="任务列表"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(target.querySelector('[aria-label="项目列表"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
    select("普通项");
    expect(target.querySelector('[aria-label="项目列表"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    select("任务项", "普通项");
    for (const label of ["项目列表", "编号列表", "任务列表"])
      expect(target.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-checked")).toBe(
        "false",
      );
    select("引用段");
    expect(target.querySelector('[aria-label="引用"]')?.getAttribute("aria-pressed")).toBe("true");
    select("引用段", "正文段");
    expect(target.querySelector('[aria-label="引用"]')?.getAttribute("aria-pressed")).toBe("mixed");
    select("正文段");
    expect(target.querySelector('[aria-label="引用"]')?.getAttribute("aria-pressed")).toBe("false");
  } finally {
    await unmount(app);
    view.destroy();
    host.remove();
    target.remove();
  }
});
