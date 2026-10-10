/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview, ImagePreview } from "@reader/renderer/previews";

const { openPdf, renderPdfPage } = vi.hoisted(() => ({
  openPdf: vi.fn(),
  renderPdfPage: vi.fn(),
}));
vi.mock("@reader/renderer/preview/pdf", () => ({ openPdf, renderPdfPage }));

const components = new Set<ReturnType<typeof mount>>();
const destroy = vi.fn(async () => {});
const cancel = vi.fn();
const revoke = vi.fn();
const getPage = vi.fn(async (number: number) => pdfPage(number));
const pdf = { numPages: 3, getPage };
const resizeListeners = new Map<Element, (entries: { target: Element }[]) => void>();
let viewportWidth = 800;
let viewportHeight = 600;

function pdfPage(number: number) {
  return {
    number,
    pageNumber: number,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  viewportWidth = 800;
  viewportHeight = 600;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly notify: (entries: { target: Element }[]) => void) {}
      observe(element: Element) {
        resizeListeners.set(element, this.notify);
      }
      unobserve(element: Element) {
        resizeListeners.delete(element);
      }
      disconnect() {
        resizeListeners.clear();
      }
    },
  );
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = revoke;
    },
  );
  openPdf.mockReturnValue({ promise: Promise.resolve(pdf), destroy });
  getPage.mockImplementation(async (number: number) => pdfPage(number));
  renderPdfPage.mockImplementation(
    (page: ReturnType<typeof pdfPage>, _scale: number, host: HTMLElement) => {
      host.textContent = `page ${page.number}`;
      return { promise: Promise.resolve(), cancel };
    },
  );
});

afterEach(async () => {
  for (const component of components) await unmount(component);
  components.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function startPdf() {
  const component = mount(PdfPreview, {
    target: document.body,
    props: { bytes: new Uint8Array([37, 80, 68, 70]) },
  });
  components.add(component);
  flushSync();
  return component;
}

async function resize(width: number, height: number) {
  viewportWidth = width;
  viewportHeight = height;
  for (const [element, notify] of resizeListeners) notify([{ target: element }]);
  flushSync();
  await vi.dynamicImportSettled();
  flushSync();
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
  );
  if (!element) throw new Error(`找不到按钮：${label}`);
  return element;
}

function startImage() {
  components.add(
    mount(ImagePreview, {
      target: document.body,
      props: { path: "picture.png", bytes: new Uint8Array([1, 2]) },
    }),
  );
  flushSync();
  const image = document.querySelector("img")!;
  const viewport = document.querySelector<HTMLDivElement>(".preview-viewport")!;
  Object.defineProperties(image, {
    naturalWidth: { value: 1600 },
    naturalHeight: { value: 1200 },
  });
  image.dispatchEvent(new Event("load"));
  flushSync();
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, viewportWidth, viewportHeight),
  );
  vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => {
    const width = Number.parseFloat(image.style.width);
    const height = Number.parseFloat(image.style.height);
    return new DOMRect(
      Math.max(16, (viewportWidth - width) / 2) - viewport.scrollLeft,
      Math.max(16, (viewportHeight - height) / 2) - viewport.scrollTop,
      width,
      height,
    );
  });
  const capture = new Set<number>();
  viewport.setPointerCapture = vi.fn((id: number) => capture.add(id));
  viewport.hasPointerCapture = (id: number) => capture.has(id);
  viewport.releasePointerCapture = vi.fn((id: number) => capture.delete(id));
  return { image, viewport };
}

function pointer(node: HTMLElement, type: string, pointerId: number, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    button: { value: 0 },
    pointerType: { value: "mouse" },
    clientX: { value: x },
    clientY: { value: y },
  });
  node.dispatchEvent(event);
}

async function pageReady(number: number) {
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector(".pdf-page:not([aria-hidden])")?.textContent).toBe(
      `page ${number}`,
    );
  });
}

describe("附件预览生命周期与交互", () => {
  it("图片放大保留画布中心的阅读视点，连续缩放不漂移", async () => {
    const { viewport } = startImage();
    button("原始大小").click();
    await vi.waitFor(() => {
      flushSync();
      expect(viewport.scrollLeft).toBe(416);
      expect(viewport.scrollTop).toBe(316);
    });
    viewport.scrollLeft = 600;
    viewport.scrollTop = 400;
    button("放大").click();
    await vi.waitFor(() => {
      flushSync();
      expect(viewport.scrollLeft).toBeCloseTo(846, 5);
      expect(viewport.scrollTop).toBeCloseTo(571, 5);
    });
    button("缩小").click();
    await vi.waitFor(() => {
      flushSync();
      expect(viewport.scrollLeft).toBeCloseTo(600, 5);
      expect(viewport.scrollTop).toBeCloseTo(400, 5);
    });
  });

  it("图片拖动只归属于起始指针，Escape 取消并释放画布捕获", () => {
    const { viewport } = startImage();
    viewport.scrollLeft = 400;
    viewport.scrollTop = 300;
    pointer(viewport, "pointerdown", 1, 300, 200);
    expect(document.activeElement).toBe(viewport);
    pointer(viewport, "pointermove", 2, 200, 100);
    expect(viewport.scrollLeft).toBe(400);
    pointer(viewport, "pointercancel", 2, 200, 100);
    pointer(viewport, "pointermove", 1, 250, 150);
    expect(viewport.scrollLeft).toBe(450);
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(viewport.scrollLeft).toBe(400);
    expect(viewport.scrollTop).toBe(300);
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer(viewport, "pointermove", 1, 200, 100);
    expect(viewport.scrollLeft).toBe(400);
  });

  it("PDF 缩放在新画面完成前保留当前页，迟到的旧绘制不夺回展示", async () => {
    startPdf();
    await pageReady(1);
    const original = document.querySelector(".pdf-page");
    const pending = deferred<void>();
    const renders = renderPdfPage.mock.calls.length;
    renderPdfPage.mockImplementationOnce((page, _scale, host: HTMLElement) => {
      host.textContent = `zoom ${page.number}`;
      return { promise: pending.promise, cancel };
    });
    button("放大").click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain("正在渲染");
      expect(renderPdfPage).toHaveBeenCalledTimes(renders + 1);
    });
    expect(original?.isConnected).toBe(true);
    expect(original?.parentElement?.classList.contains("concealed")).toBe(false);
    button("下一页").click();
    await pageReady(2);
    pending.resolve();
    await vi.dynamicImportSettled();
    flushSync();
    expect(document.querySelector(".pdf-page")?.textContent).toBe("page 2");
  });

  it("PDF 固定比例下调整窗口不重新绘制页面", async () => {
    startPdf();
    await pageReady(1);
    button("原始大小").click();
    await vi.waitFor(() => {
      flushSync();
      expect(renderPdfPage.mock.calls.at(-1)?.[1]).toBe(1);
    });
    const renders = renderPdfPage.mock.calls.length;
    const cancels = cancel.mock.calls.length;
    for (let size = 650; size <= 950; size += 50) await resize(size, size);
    expect(renderPdfPage).toHaveBeenCalledTimes(renders);
    expect(cancel).toHaveBeenCalledTimes(cancels);
  });

  it("PDF 适应窗口只在有效比例变化时重绘，未测量尺寸时等待", async () => {
    viewportWidth = 0;
    viewportHeight = 0;
    startPdf();
    await vi.waitFor(() => {
      flushSync();
      expect(getPage).toHaveBeenCalledOnce();
    });
    expect(renderPdfPage).not.toHaveBeenCalled();
    await resize(800, 600);
    await pageReady(1);
    const renders = renderPdfPage.mock.calls.length;
    const initialScale = renderPdfPage.mock.calls.at(-1)?.[1];
    await resize(900, 600);
    expect(renderPdfPage).toHaveBeenCalledTimes(renders);
    await resize(900, 700);
    expect(renderPdfPage).toHaveBeenCalledTimes(renders + 1);
    expect(renderPdfPage.mock.calls.at(-1)?.[1]).toBeGreaterThan(initialScale);
  });

  it("PDF 翻页和缩放只更新阅读状态，离开时取消绘制并销毁解析任务", async () => {
    const component = startPdf();
    await pageReady(1);
    expect(button("上一页").disabled).toBe(true);
    button("下一页").click();
    await pageReady(2);
    expect(cancel).toHaveBeenCalled();
    const firstScale = renderPdfPage.mock.calls.at(-1)?.[1];
    button("放大").click();
    await vi.waitFor(() => {
      flushSync();
      expect(renderPdfPage.mock.calls.at(-1)?.[1]).toBeGreaterThan(firstScale);
    });
    button("下一页").click();
    await pageReady(3);
    expect(button("下一页").disabled).toBe(true);
    await unmount(component);
    components.delete(component);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("晚到的旧页不会覆盖新页，非法页码恢复为当前页", async () => {
    const pending = deferred<ReturnType<typeof pdfPage>>();
    getPage.mockImplementationOnce(() => pending.promise);
    startPdf();
    await vi.waitFor(() => {
      flushSync();
      expect(getPage).toHaveBeenCalledWith(1);
    });
    button("下一页").click();
    await pageReady(2);
    pending.resolve(pdfPage(1));
    await Promise.resolve();
    flushSync();
    expect(document.querySelector(".pdf-page")?.textContent).toBe("page 2");
    const field = document.querySelector<HTMLInputElement>('input[aria-label="PDF 页码"]')!;
    field.value = "999";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(field.value).toBe("2");
    expect(getPage).not.toHaveBeenCalledWith(999);
  });

  it("取消旧页渲染后，新页加载失败不会残留正在渲染状态", async () => {
    const pending = deferred<void>();
    renderPdfPage.mockReturnValueOnce({ promise: pending.promise, cancel });
    startPdf();
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain("正在渲染");
    });
    getPage.mockRejectedValueOnce(new Error("页面损坏"));
    button("下一页").click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("页面损坏");
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("正在渲染");
    pending.resolve();
  });

  it("解析失败显示错误，正在加载时离开也销毁任务", async () => {
    openPdf.mockImplementationOnce(() => ({
      promise: Promise.reject(new Error("文件损坏")),
      destroy,
    }));
    const component = startPdf();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("文件损坏");
    });
    await unmount(component);
    components.delete(component);
    const pending = deferred<typeof pdf>();
    openPdf.mockReturnValueOnce({ promise: pending.promise, destroy });
    const second = startPdf();
    await vi.waitFor(() => expect(openPdf).toHaveBeenCalledTimes(2));
    await unmount(second);
    components.delete(second);
    pending.resolve(pdf);
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(getPage).not.toHaveBeenCalled();
  });

  it("密码错误可重试，退出密码等待时释放解析任务", async () => {
    const pending = deferred<typeof pdf>();
    const submit = vi.fn();
    openPdf.mockImplementationOnce((_bytes, onPassword) => {
      onPassword(submit, true);
      return { promise: pending.promise, destroy };
    });
    const component = startPdf();
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain("密码不正确");
    });
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "secret";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(submit).toHaveBeenCalledWith("secret");
    await unmount(component);
    components.delete(component);
    expect(destroy).toHaveBeenCalledTimes(1);
    pending.resolve(pdf);
  });

  it("图片支持原始大小和适应窗口，销毁时回收 Blob URL", async () => {
    const component = mount(ImagePreview, {
      target: document.body,
      props: { path: "picture.png", bytes: new Uint8Array([1, 2]) },
    });
    components.add(component);
    flushSync();
    const image = document.querySelector("img")!;
    Object.defineProperties(image, {
      naturalWidth: { value: 1600 },
      naturalHeight: { value: 1200 },
    });
    image.dispatchEvent(new Event("load"));
    flushSync();
    expect(Number.parseFloat(image.style.width)).toBeLessThan(800);
    button("原始大小").click();
    flushSync();
    expect(image.style.width).toBe("1600px");
    button("适应窗口").click();
    flushSync();
    expect(Number.parseFloat(image.style.width)).toBeLessThan(800);
    await unmount(component);
    components.delete(component);
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  it("图片解码失败显示明确提示", async () => {
    components.add(
      mount(ImagePreview, {
        target: document.body,
        props: { path: "broken.png", bytes: new Uint8Array() },
      }),
    );
    flushSync();
    document.querySelector("img")!.dispatchEvent(new Event("error"));
    flushSync();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("图片无法显示");
    expect(button("放大").disabled).toBe(true);
  });
});
