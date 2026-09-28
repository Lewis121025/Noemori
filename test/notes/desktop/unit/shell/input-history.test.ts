/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InputHistory } from "@app/input-history";

let history: InputHistory;
let dispose: () => void;
let ownsInput: boolean;
const changed = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  ownsInput = true;
  changed.mockClear();
  history = new InputHistory(() => ownsInput, changed);
  dispose = history.bind(document, (action) => history.apply(action));
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function input(value = ""): HTMLInputElement {
  const field = document.createElement("input");
  field.value = value;
  document.body.append(field);
  field.focus();
  field.setSelectionRange(value.length, value.length);
  return field;
}

function edit(field: HTMLInputElement, value: string, type = "insertText"): void {
  field.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type }),
  );
  field.value = value;
  field.setSelectionRange(value.length, value.length);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type }));
}

it("空控件不借用其他输入框的历史，系统旧目标事件按当前焦点路由", () => {
  const first = input();
  edit(first, "查找词");
  const second = input();
  expect(history.availability()).toEqual({ undo: false, redo: false });
  const nativeUndo = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "historyUndo",
  });
  first.dispatchEvent(nativeUndo);
  expect(nativeUndo.defaultPrevented).toBe(true);
  expect(first.value).toBe("查找词");
  expect(document.activeElement).toBe(second);
  edit(second, "替换词");
  history.apply("undo");
  expect(second.value).toBe("");
  expect(first.value).toBe("查找词");
  first.focus();
  history.apply("undo");
  expect(first.value).toBe("");
  second.focus();
  history.apply("redo");
  expect(second.value).toBe("替换词");
});

it("连续输入按停顿分组，选区替换独立撤销并恢复中文和 emoji 的选区", () => {
  const field = input();
  edit(field, "a");
  edit(field, "ab");
  vi.advanceTimersByTime(501);
  edit(field, "ab中文😀");
  history.apply("undo");
  expect(field.value).toBe("ab");
  history.apply("undo");
  expect(field.value).toBe("");
  history.apply("redo");
  history.apply("redo");
  field.setSelectionRange(2, 6, "backward");
  edit(field, "ab替换");
  history.apply("undo");
  expect(field.value).toBe("ab中文😀");
  expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
    2,
    6,
    "backward",
  ]);
  history.apply("redo");
  expect(field.value).toBe("ab替换");
  expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
});

it("粘贴与剪切是独立步骤，撤销后的新输入丢弃旧重做分支", () => {
  const field = input("前缀");
  edit(field, "前缀粘贴", "insertFromPaste");
  field.setSelectionRange(2, 4);
  edit(field, "前缀", "deleteByCut");
  history.apply("undo");
  expect(field.value).toBe("前缀粘贴");
  edit(field, "前缀新内容");
  expect(history.availability()).toEqual({ undo: true, redo: false });
  history.apply("redo");
  expect(field.value).toBe("前缀新内容");
});

it("中文组词及确认后的最终输入合并为一步，组词中不允许撤销", () => {
  const field = input("原文");
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  edit(field, "原文zhong", "insertCompositionText");
  expect(history.availability()).toEqual({ undo: false, redo: false });
  history.apply("undo");
  expect(field.value).toBe("原文zhong");
  edit(field, "原文中", "insertCompositionText");
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  edit(field, "原文中文", "insertText");
  vi.runOnlyPendingTimers();
  history.apply("undo");
  expect(field.value).toBe("原文");
  expect(history.availability()).toEqual({ undo: false, redo: true });
  history.apply("redo");
  expect(field.value).toBe("原文中文");
});

it("取消组词不新增历史，也不清除之前的重做", () => {
  const field = input("原文");
  edit(field, "原文输入");
  history.apply("undo");
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  edit(field, "原文拼音", "insertCompositionText");
  edit(field, "原文", "insertCompositionText");
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  vi.runOnlyPendingTimers();
  expect(history.availability()).toEqual({ undo: false, redo: true });
  history.apply("redo");
  expect(field.value).toBe("原文输入");
});

it("程序重新初始化控件会使旧历史失效，没有 beforeinput 的输入仍有焦点基准", () => {
  const field = input("旧名称");
  edit(field, "编辑名称");
  field.value = "新名称";
  expect(history.availability()).toEqual({ undo: false, redo: false });
  field.value = "新名称输入";
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
  );
  history.apply("undo");
  expect(field.value).toBe("新名称");
});

it("只读控件和文档源码不能被辅助历史接管，复用新控件不会继承已移除控件的历史", () => {
  const first = input();
  edit(first, "辅助输入");
  first.readOnly = true;
  expect(history.availability()).toEqual({ undo: false, redo: false });
  history.apply("undo");
  expect(first.value).toBe("辅助输入");
  first.remove();
  ownsInput = false;
  const source = input("x");
  edit(source, "x+y");
  const nativeUndo = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "historyUndo",
  });
  source.dispatchEvent(nativeUndo);
  expect(nativeUndo.defaultPrevented).toBe(false);
  history.apply("undo");
  expect(source.value).toBe("x+y");
  ownsInput = true;
  input();
  expect(history.availability()).toEqual({ undo: false, redo: false });
});

it("撤销发送 input 事件更新既有绑定，但不会把历史回放记录成新编辑", () => {
  const field = input("原文");
  const binding = vi.fn();
  field.addEventListener("input", binding);
  edit(field, "新文");
  history.apply("undo");
  history.apply("redo");
  expect(binding).toHaveBeenCalledTimes(3);
  expect(history.availability()).toEqual({ undo: true, redo: false });
  history.apply("undo");
  expect(history.availability()).toEqual({ undo: false, redo: true });
});

it("数字输入的普通 input 事件可以撤销，不对不支持选区的控件调用选区 API", () => {
  const field = document.createElement("input");
  field.type = "number";
  field.value = "1";
  document.body.append(field);
  field.focus();
  field.value = "2";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  history.apply("undo");
  expect(field.value).toBe("1");
  history.apply("redo");
  expect(field.value).toBe("2");
});

it("卸载释放事件和等待中的组词任务，不再通知或记录输入", () => {
  const field = input();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  edit(field, "组词", "insertCompositionText");
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  dispose();
  changed.mockClear();
  vi.runOnlyPendingTimers();
  edit(field, "后续");
  expect(changed).not.toHaveBeenCalled();
  expect(history.availability()).toEqual({ undo: false, redo: false });
});

it("对话框关闭后复用相同输入元素和初始值，也不会继承已取消草稿的重做", () => {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  const field = input("原名称");
  dialog.append(field);
  field.focus();
  edit(field, "已取消的新名称");
  history.apply("undo");
  expect(history.availability()).toEqual({ undo: false, redo: true });
  dialog.open = false;
  dialog.dispatchEvent(new Event("close"));
  dialog.open = true;
  field.focus();
  expect(history.availability()).toEqual({ undo: false, redo: false });
  history.apply("redo");
  expect(field.value).toBe("原名称");
});
