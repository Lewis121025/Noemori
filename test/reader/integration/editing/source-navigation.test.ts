/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { mathInputPlugins, mathNodeViews } from "@reader/renderer/engine/rendering/math-view";
import { editSelectedSource, sourceEditingPlugin } from "@reader/renderer/engine/editing/source-editing";

vi.mock("@reader/renderer/engine/rendering/mathjax", () => ({
  peekRenderedTex: (source: string) => {
    const preview = document.createElement("span");
    preview.textContent = source;
    return preview;
  },
}));

let view: EditorView;
function start(source = "前 $x+y$ 后\n"): void {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown(source),
      plugins: [
        history(),
        sourceEditingPlugin,
        ...mathInputPlugins(),
        keymap({ "Mod-z": undo, "Mod-y": redo }),
      ],
    }),
    nodeViews: mathNodeViews,
  });
}
async function edit(): Promise<HTMLInputElement | HTMLTextAreaElement> {
  let pos = -1;
  view.state.doc.descendants((node, offset) => {
    if (node.type.name.startsWith("math_")) pos = offset;
  });
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  editSelectedSource(view.state, view.dispatch);
  await Promise.resolve();
  const field = view.dom.querySelector<HTMLInputElement | HTMLTextAreaElement>(".math-source");
  if (field === null) throw new Error("源码输入框未打开");
  return field;
}
function press(field: HTMLElement, key: string, options: KeyboardEventInit = {}): void {
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
}
afterEach(() => {
  view?.destroy();
  document.body.replaceChildren();
});

describe("源码与正文之间的键盘导航", () => {
  it("清空公式后退出源码仍有可操作入口，可以补回内容", async () => {
    start();
    const field = await edit();
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    press(field, "Escape");
    const placeholder = view.dom.querySelector("button.source-empty");
    if (!(placeholder instanceof HTMLButtonElement)) throw new Error("空公式缺少继续编辑入口");
    expect(placeholder.textContent).toBe("补充公式");
    placeholder.click();
    await Promise.resolve();
    const reopened = view.dom.querySelector(".math-source");
    expect(reopened).not.toBeNull();
    expect(document.activeElement).toBe(reopened);
  });
  it("以公式开头的笔记默认保持阅读预览", () => {
    start("$$\nx+y\n$$\n");
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.dom.querySelector(".math-source")).toBeNull();
    expect(view.dom.textContent).toBe("x+y");
  });

  it("Esc 保留修改并返回节点选区，模式切换不污染撤销栈", async () => {
    start();
    const field = await edit();
    field.value = "x-y";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    press(field, "Escape");
    expect(view.dom.querySelector(".math-source")).toBeNull();
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(document.activeElement).toBe(view.dom);
    expect(serializeMarkdown(view.state.doc)).toBe("前 $x-y$ 后\n");
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe("前 $x+y$ 后\n");
  });

  it.each([
    ["ArrowLeft", 0, 3],
    ["ArrowRight", 3, 4],
    ["Enter", 1, 4],
  ] as const)("%s 从源码返回对应的正文边界", async (key, caret, expected) => {
    start();
    const field = await edit();
    field.setSelectionRange(caret, caret);
    press(field, key);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(expected);
    expect(view.dom.querySelector(".math-source")).toBeNull();
    expect(document.activeElement).toBe(view.dom);
  });

  it("移动源码内部光标、扩展选区和输入法确认都不退出编辑", async () => {
    start();
    const field = await edit();
    field.setSelectionRange(1, 1);
    press(field, "ArrowLeft");
    field.setSelectionRange(0, 0);
    press(field, "ArrowLeft", { shiftKey: true });
    press(field, "Enter", { isComposing: true });
    press(field, "Escape", { isComposing: true });
    expect(view.dom.querySelector(".math-source")).toBe(field);
    expect(serializeMarkdown(view.state.doc)).toBe("前 $x+y$ 后\n");
  });

  it("源码内的撤销与重做走文档历史，仍可继续输入", async () => {
    start();
    const field = await edit();
    field.value = "x-y";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    press(field, "z", { ctrlKey: true });
    expect(field.value).toBe("x+y");
    press(field, "y", { ctrlKey: true });
    expect(field.value).toBe("x-y");
    expect(view.dom.querySelector(".math-source")).toBe(field);
  });

  it("原生历史输入与源码快捷键共用文档历史，组词期间不执行撤销", async () => {
    start();
    const field = await edit();
    field.value = "x-y";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const nativeHistory = (inputType: string) => {
      const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    nativeHistory("historyUndo");
    expect(field.value).toBe("x-y");
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    nativeHistory("historyUndo");
    expect(field.value).toBe("x+y");
    press(field, "y", { ctrlKey: true });
    expect(field.value).toBe("x-y");
    press(field, "z", { ctrlKey: true });
    nativeHistory("historyRedo");
    expect(field.value).toBe("x-y");
    expect(document.activeElement).toBe(field);
    expect(serializeMarkdown(view.state.doc)).toBe("前 $x-y$ 后\n");
  });

  it("原生撤销移除正在编辑的公式时，焦点回正文并可继续输入", async () => {
    start("前 后\n");
    // jsdom 不计算文字矩形；原生窗口中的滚动与保存由桌面历史流程验证。
    view.setProps({ handleScrollToSelection: () => true });
    const math = view.state.schema.nodes["math_inline"];
    if (!math) throw new Error("缺少行内公式类型");
    view.dispatch(view.state.tr.insert(3, math.create({ tex: "x" })));
    const field = await edit();
    field.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }),
    );
    expect(field.isConnected).toBe(false);
    expect(document.activeElement).toBe(view.dom);
    expect(serializeMarkdown(view.state.doc)).toBe("前 后\n");
    view.dispatch(view.state.tr.insertText("继续"));
    expect(view.state.doc.textContent).toContain("继续");
  });

  it.each(["Enter", "Escape", "ArrowLeft", "ArrowRight"])("输入法边界按键 %s 不退出源码，也不拦截系统候选操作", async (key) => {
    start();
    const field = await edit();
    field.setSelectionRange(key === "ArrowRight" ? field.value.length : 0, key === "ArrowRight" ? field.value.length : 0);
    const event = new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    expect(view.dom.querySelector(".math-source")).toBe(field);
    expect(event.defaultPrevented).toBe(false);
  });

  it("输入块级公式围栏后直接进入空源码", async () => {
    start("");
    view.dispatch(view.state.tr.insertText("$$"));
    view.someProp("handleKeyDown", (handle) =>
      handle(view, new KeyboardEvent("keydown", { key: "Enter" })),
    );
    await Promise.resolve();
    const field = view.dom.querySelector(".math-source");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("文末块级公式用快捷键完成后，可以在下一段继续写作", async () => {
    start("$$\nx+y\n$$\n");
    const field = await edit();
    press(field, "Enter", { ctrlKey: true });
    expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    view.dispatch(view.state.tr.insertText("继续写作"));
    expect(serializeMarkdown(view.state.doc)).toBe("$$\nx+y\n$$\n\n继续写作\n");
  });
});
