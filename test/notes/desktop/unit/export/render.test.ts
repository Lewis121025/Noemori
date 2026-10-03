import { computeExport } from "@reader/main/export/computation";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExportRenderer, parseRenderReply } from "@reader/main/export/render";
const validPdf = new Uint8Array(
  readFileSync(new URL("../../fixtures/preview.pdf", import.meta.url)),
);

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: function () {
    return boundary.create();
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function windowFixture() {
  const events = new EventEmitter();
  const contents = Object.assign(events, {
    setWindowOpenHandler: vi.fn(),
    session: { webRequest: { onBeforeRequest: vi.fn() } },
    executeJavaScript: vi.fn<(script: string) => Promise<unknown>>(async () => ({ kind: "ready" })),
    printToPDF: vi.fn(async () => validPdf),
  });
  const window = {
    webContents: contents,
    loadURL: vi.fn(async () => {}),
    loadFile: vi.fn(async () => {}),
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
  };
  boundary.create.mockReturnValue(window);
  return { window, contents };
}

beforeEach(() => {
  boundary.create.mockReset();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("EXP-RENDER 隔离渲染生命周期", () => {
  it("只通过固定入口传入 JSON，A4 打印结束销毁窗口并撤销监听", async () => {
    const { window, contents } = windowFixture();
    const signal = new AbortController().signal;
    const renderer = createExportRenderer(signal, computeExport);
    const result = await renderer.pdf({ text: '"; globalThis.injection = true; //' }, []);
    expect(result).toEqual(validPdf);
    expect(window.loadFile).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      'window.noemoriExport({"kind":"document","doc":{"text":"\\\"; globalThis.injection = true; //"},"anchors":[],"destinations":[]})',
    );
    expect(contents.printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: "A4", printBackground: true, generateTaggedPDF: true }),
    );
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
    const preventDefault = vi.fn();
    contents.emit("will-navigate", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const callback = vi.fn();
    contents.session.webRequest.onBeforeRequest.mock.calls[0]?.[1]({}, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it("开发页与图像回复使用同一销毁边界", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173/");
    const { window, contents } = windowFixture();
    contents.executeJavaScript.mockResolvedValue({ kind: "svg", svg: "<svg/>" });
    expect(
      await createExportRenderer(new AbortController().signal, computeExport).render({
        kind: "mermaid",
        source: "graph LR",
      }),
    ).toEqual({ kind: "svg", svg: "<svg/>" });
    expect(window.loadURL).toHaveBeenCalledWith("http://localhost:5173/export.html");
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(contents.printToPDF).not.toHaveBeenCalled();
    const filter = contents.session.webRequest.onBeforeRequest.mock.calls[0]?.[1];
    const allowed = vi.fn();
    filter({ url: "http://localhost:5173/export.html", resourceType: "mainFrame" }, allowed);
    expect(allowed).toHaveBeenCalledWith({ cancel: false });
    for (const details of [
      { url: "https://outside.test/script.js", resourceType: "script" },
      { url: "http://localhost:5173/unfrozen.png", resourceType: "image" },
    ]) {
      const denied = vi.fn();
      filter(details, denied);
      expect(denied).toHaveBeenCalledWith({ cancel: true });
    }
  });

  it.for(["abort", "crash", "timeout", "load", "reply", "print"])(
    "失败和取消不会留下隐藏窗口：%s",
    async (failure) => {
      vi.useFakeTimers();
      const { window, contents } = windowFixture();
      const controller = new AbortController();
      const loading = deferred<void>();
      if (["abort", "crash", "timeout"].includes(failure))
        window.loadFile.mockReturnValue(loading.promise);
      if (failure === "load") window.loadFile.mockRejectedValue(new Error("load failed"));
      if (failure === "reply")
        contents.executeJavaScript.mockResolvedValue({ kind: "svg", svg: "not ready" });
      if (failure === "print") contents.printToPDF.mockRejectedValue(new Error("print failed"));
      const running = createExportRenderer(controller.signal, computeExport).pdf({}, []);
      const rejected = expect(running).rejects.toThrow();
      if (failure === "abort") controller.abort();
      if (failure === "crash") contents.emit("render-process-gone");
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(180000);
      await rejected;
      expect(window.destroy).toHaveBeenCalledOnce();
      expect(contents.listenerCount("render-process-gone")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("已取消的任务不创建窗口，重复销毁不作用于已经结束的窗口", async () => {
    const { window } = windowFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createExportRenderer(controller.signal, computeExport).pdf({}, []),
    ).rejects.toThrow();
    expect(boundary.create).not.toHaveBeenCalled();
    window.isDestroyed.mockReturnValue(true);
    await createExportRenderer(new AbortController().signal, computeExport).pdf({}, []);
    expect(window.destroy).not.toHaveBeenCalled();
  });

  it("跨进程渲染协议拒绝未知、缺字段和不可能的尺寸", () => {
    for (const value of [
      null,
      [],
      {},
      { kind: "other" },
      { kind: "svg", svg: 1 },
      { kind: "html" },
      { kind: "image", data: "x", width: 0, height: 1 },
      { kind: "image", data: "x", width: 1, height: NaN },
    ])
      expect(() => parseRenderReply(value)).toThrow();
    for (const value of [
      { kind: "ready" },
      { kind: "html", doc: {} },
      { kind: "svg", svg: "<svg/>" },
      { kind: "image", data: "x", width: 1, height: 1 },
    ])
      expect(parseRenderReply(value)).toEqual(value);
  });
});
