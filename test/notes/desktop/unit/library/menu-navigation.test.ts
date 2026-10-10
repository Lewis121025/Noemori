/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { menuNavigation } from "@reader/renderer/library/menu-navigation";

let menu: HTMLDivElement,
  trigger: HTMLButtonElement,
  first: HTMLButtonElement,
  second: HTMLButtonElement;
let dispose: () => void;

beforeEach(() => {
  menu = document.createElement("div");
  trigger = document.createElement("button");
  first = document.createElement("button");
  second = document.createElement("button");
  first.textContent = "新建笔记";
  second.textContent = "新建文件夹";
  menu.append(first, second);
  document.body.append(trigger, menu);
  dispose = menuNavigation(menu).destroy;
});

afterEach(() => {
  dispose();
  menu.remove();
  trigger.remove();
});

function opened(): void {
  const event = new Event("toggle");
  Object.defineProperty(event, "newState", { value: "open" });
  menu.dispatchEvent(event);
}

it("打开事件迟到时，保留用户已用方向键移到的选项", () => {
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(second);
  opened();
  expect(document.activeElement).toBe(second);
});

it("从入口打开时，焦点进入第一个可用选项", () => {
  first.disabled = true;
  trigger.focus();
  opened();
  expect(document.activeElement).toBe(second);
});

it("卸载后不再接管键盘或迟到的打开事件", () => {
  dispose();
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(first);
  trigger.focus();
  opened();
  expect(document.activeElement).toBe(trigger);
});
