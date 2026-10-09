import { beforeEach } from "vitest";

/** jsdom 不计算布局或原生浮层；几何和顶层交互由 Electron 测试验证。 */
if (typeof document !== "undefined") {
  // jsdom 不实现系统媒体偏好；默认不减少动效，偏好切换用例可覆盖此入口。
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query) =>
      Object.assign(new EventTarget(), {
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
      });
  }
  beforeEach(() => {
    // 完整 App 会恢复字体；字体故障用例可以覆盖此能力，真实加载交给 Electron 验证。
    if (document.fonts === undefined)
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { load: async () => [], ready: Promise.resolve() },
      });
  });
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (value?: string): void {
      this.returnValue = value ?? "";
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
  if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
    HTMLElement.prototype.scrollIntoView = function (): void {};
  }
  // 编辑器获得焦点后会测量选区；jsdom 缺少 Range 几何，真实尺寸由桌面测试负责。
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
  if (typeof ResizeObserver === "undefined") {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    });
  }
  if (typeof HTMLElement.prototype.hidePopover !== "function") {
    HTMLElement.prototype.hidePopover = function (): void {};
  }
  if (typeof HTMLElement.prototype.showPopover !== "function") {
    HTMLElement.prototype.showPopover = function (): void {};
  }
}
