/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CodeEditor from "@reader/renderer/components/editors/CodeEditor.svelte";
import type { CodeEditorApi } from "@reader/renderer/engine/editing/editor-api";

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;
const registered: { api: CodeEditorApi | null } = { api: null };

beforeEach(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  target = document.createElement("div");
  document.body.append(target);
  component = mount(CodeEditor, {
    target,
    props: {
      path: "笔记.md",
      source: "开头。\n\n继续写作。\n\n结尾。",
      onDirty: () => {},
      onSave: () => {},
      register: (api) => {
        registered.api = api;
      },
    },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  target.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

it("粘贴查找词后第一次回车就定位，替换按钮使用刚输入的替换词", () => {
  const api = registered.api;
  if (api === null) throw new Error("源码编辑器未注册");
  api.openSearch();
  const input = target.querySelector<HTMLInputElement>('input[name="search"]');
  const replace = target.querySelector<HTMLInputElement>('input[name="replace"]');
  if (input === null || replace === null) throw new Error("源码查找框未打开");
  // 粘贴与输入法提交提供 input 事件，不能依赖额外的 keyup 或失焦才更新查询。
  input.value = "继续写作。";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
  );
  api.focus();
  expect(document.getSelection()?.toString()).toBe("继续写作。");
  replace.value = "新的想法。";
  replace.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  target.querySelector<HTMLButtonElement>('button[name="replaceAll"]')?.click();
  expect(new TextDecoder().decode(api.snapshot().bytes)).toBe("开头。\n\n新的想法。\n\n结尾。");
});
