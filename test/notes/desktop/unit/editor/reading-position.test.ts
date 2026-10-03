/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureReadingPosition } from "@reader/renderer/editor/reading-position";

const elementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
let scroller: HTMLDivElement;
let editor: HTMLDivElement;

beforeEach(() => {
  scroller = document.createElement("div");
  editor = document.createElement("div");
  scroller.append(editor);
  document.body.append(scroller);
  scroller.scrollTop = 600;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});

afterEach(() => {
  scroller.remove();
  vi.restoreAllMocks();
  if (elementFromPoint) Object.defineProperty(document, "elementFromPoint", elementFromPoint);
  else Reflect.deleteProperty(document, "elementFromPoint");
});

describe("宽表面中的阅读锚点", () => {
  it("取点落在居中文字栏内，避免把段落外边界当成文字基线", () => {
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 1200, 600));
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -500, 1200, 2000));
    // 768px 文字栏居中于 1200px 表面；边缘留白命中块边界，字形顶部比块边界低半行距。
    const positionAt = ({ left }: { left: number }) => (left >= 216 && left <= 984 ? 42 : 41);
    const topAt = (position: number) => (position === 42 ? 108 : 102.5);
    const captured = captureReadingPosition(editor, scroller, positionAt, topAt);
    expect(captured.anchor).toEqual({ position: 42, offset: 8 });
    expect(scroller.scrollTop).toBe(600);
  });

  it("内容与滚动区没有水平交集时不采集屏幕外的锚点", () => {
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 600));
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(new DOMRect(500, -500, 400, 2000));
    const positionAt = vi.fn(() => 42);
    const captured = captureReadingPosition(editor, scroller, positionAt, () => 108);
    expect(captured.anchor).toBeNull();
    expect(captured.top).toBe(600);
    expect(positionAt).not.toHaveBeenCalled();
  });
});
