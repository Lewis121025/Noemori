/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MessageText from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/MessageText.svelte";

let target: HTMLDivElement;
let view: MessageText;
let writeText: ReturnType<typeof vi.fn>;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  target = document.createElement("div");
  document.body.append(target);
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(async () => {
  if (view) await unmount(view);
  target.remove();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});
function render(text: string): void {
  view = mount(MessageText, { target, props: { text, openLink: async () => {} } });
  flushSync();
}
function copy(): void {
  const button = target.querySelector<HTMLButtonElement>('[aria-label="复制代码"]');
  expect(button).not.toBeNull();
  button!.click();
}

it("Markdown 表格保留列标题语义和正文单元格，单列正文不会被当作标题", () => {
  render("| 方案 | 取舍 |\n| --- | --- |\n| A | 简洁 |\n| B | 完整 |");
  expect([...target.querySelectorAll("thead th")].map((node) => node.textContent)).toEqual([
    "方案",
    "取舍",
  ]);
  expect(
    [...target.querySelectorAll("thead th")].every((node) => node.getAttribute("scope") === "col"),
  ).toBe(true);
  expect(target.querySelectorAll("tbody tr")).toHaveLength(2);
  expect([...target.querySelectorAll("tbody td")].map((node) => node.textContent)).toEqual([
    "A",
    "简洁",
    "B",
    "完整",
  ]);
});

it("代码显示语言，复制保留代码原文的缩进和换行，成功后给出反馈", async () => {
  render("```typescript\nfunction greet() {\n  return '你好';\n}\n```");
  expect(target.querySelector(".code-language")?.textContent).toBe("typescript");
  copy();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[aria-label="已复制"]')).not.toBeNull();
  });
  expect(writeText).toHaveBeenCalledWith("function greet() {\n  return '你好';\n}");
});

it("剪贴板拒绝时明确提示并允许重试，错误不会破坏消息正文", async () => {
  writeText.mockRejectedValueOnce(new Error("permission denied"));
  render("```text\n保留内容\n```");
  copy();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("复制失败");
  });
  expect(target.querySelector("pre code")?.textContent).toBe("保留内容");
  copy();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[aria-label="已复制"]')).not.toBeNull();
  });
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it("任务列表呈现完成状态，模型生成的勾选状态只读", () => {
  render("- [x] 已查阅资料\n- [ ] 待整理结论");
  const boxes = [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  expect(boxes.every((box) => box.disabled)).toBe(true);
});

it("渲染模型内容不会执行 HTML、链接脚本或自动加载远程图片", () => {
  render(
    "<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![图片](https://example.com/private.png)",
  );
  expect(target.querySelector("script")).toBeNull();
  expect(target.querySelector("a")).toBeNull();
  expect(target.querySelector("img")).toBeNull();
  expect(target.textContent).toContain("危险");
});
