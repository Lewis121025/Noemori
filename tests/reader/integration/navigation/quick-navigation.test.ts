/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickNavigation from "@reader/renderer/components/navigation/QuickNavigation.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let component: QuickNavigation;
let target: HTMLDivElement;
let workspace: ReaderWorkspaceController;
let stop: () => void;
const onOpen = vi.fn();
const paths = ["想法.md", "工作/计划.md", "生活/计划.md"];
const input = () => target.querySelector<HTMLInputElement>("input")!;
const rows = () => [...target.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];

beforeEach(async () => {
  workspace = new ReaderWorkspaceController(
    createReaderApiMock({
      vaultEntries: vi.fn(async () => paths.map((path) => ({ path, kind: "file" as const }))),
    }),
  );
  stop = workspace.start();
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(QuickNavigation, {
    target,
    props: { workspace, hidden: false, width: 232, onWidth: vi.fn(), onLibrary: vi.fn(), onOpen },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(component);
  stop();
  target.remove();
  vi.clearAllMocks();
});

function press(element: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  element.dispatchEvent(event);
  flushSync();
  return event;
}

function search(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("读写中的快速导航", () => {
  it("方向键和首尾键移动焦点而不打开文件，列表只占用一个 Tab 位置", () => {
    input().focus();
    expect(press(input(), "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[0]);
    press(rows()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[1]]);
    press(rows()[1]!, "End");
    expect(document.activeElement).toBe(rows()[2]);
    press(rows()[2]!, "Home");
    expect(document.activeElement).toBe(rows()[0]);
    press(rows()[0]!, "Escape");
    expect(document.activeElement).toBe(input());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("同名笔记显示所在目录，普通笔记保持一行，完整路径可辨认", () => {
    const work = rows().find((row) => row.dataset.path === "工作/计划.md")!;
    const life = rows().find((row) => row.dataset.path === "生活/计划.md")!;
    expect(work.textContent).toContain("工作");
    expect(life.textContent).toContain("生活");
    expect(work.title).toBe("工作/计划.md");
    expect(rows()[0]!.querySelector(".directory")).toBeNull();
  });

  it("查无结果时解释状态，清除搜索后焦点与候选恢复", () => {
    search("不存在的内容");
    expect(rows()).toHaveLength(0);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("没有匹配的笔记");
    const clear = target.querySelector<HTMLButtonElement>('[aria-label="清除快速查找"]')!;
    expect(clear).not.toBeNull();
    clear.click();
    flushSync();
    expect(input().value).toBe("");
    expect(rows()).toHaveLength(3);
    expect(document.activeElement).toBe(input());
  });

  it("确认中文候选期间，不从搜索框意外打开文件", (t) => {
    const parentKeydown = vi.fn();
    window.addEventListener("keydown", parentKeydown);
    t.onTestFinished(() => window.removeEventListener("keydown", parentKeydown));
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    press(input(), "Enter");
    expect(onOpen).not.toHaveBeenCalled();
    press(input(), "Escape");
    expect(parentKeydown).not.toHaveBeenCalled();
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    press(input(), "Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("想法.md");
    onOpen.mockClear();
    press(input(), "Enter", { isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
