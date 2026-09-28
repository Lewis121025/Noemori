/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPdf, renderPdfPage } from "@reader/renderer/engine/media/pdf";

const { drawing, cancelDrawing, renderText, cancelText, cleanup } = vi.hoisted(() => ({
  drawing: vi.fn(),
  cancelDrawing: vi.fn(),
  renderText: vi.fn(),
  cancelText: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 2 },
  getDocument: () => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: drawing,
        streamTextContent: () => new ReadableStream(),
        cleanup,
      }),
    }),
  }),
  TextLayer: class {
    render = renderText;
    cancel = cancelText;
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  drawing.mockReturnValue({ promise: Promise.resolve(), cancel: cancelDrawing });
  renderText.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
});

async function start() {
  const pdf = await openPdf(new Uint8Array(), () => {}).promise;
  const page = await pdf.getPage(1);
  const host = document.createElement("div");
  document.body.append(host);
  return { page, host };
}

describe("PDF 渲染资源的失败与取消边界", () => {
  it.each(["画布", "文字层"])("%s 失败时取消另一任务，并等两者退出后释放画布", async (layer) => {
    const failed = deferred();
    const pending = deferred();
    drawing.mockReturnValue({
      promise: layer === "画布" ? failed.promise : pending.promise,
      cancel: cancelDrawing,
    });
    renderText.mockReturnValue(layer === "文字层" ? failed.promise : pending.promise);
    const { page, host } = await start();
    const render = renderPdfPage(page, 1, host);
    const canvas = host.querySelector("canvas")!;
    failed.reject(new Error("渲染失败"));
    await expect(render.promise).rejects.toThrow("渲染失败");
    expect(cancelDrawing).toHaveBeenCalledOnce();
    expect(cancelText).toHaveBeenCalledOnce();
    expect(canvas.width).toBeGreaterThan(0);
    expect(cleanup).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitFor(() => expect(canvas.width).toBe(0));
    expect(cleanup).toHaveBeenCalledOnce();
    render.cancel();
    expect(cancelDrawing).toHaveBeenCalledOnce();
    expect(cancelText).toHaveBeenCalledOnce();
  });

  it("文字层初始化同步抛错也会撤销已经开始的画布渲染", async () => {
    renderText.mockImplementationOnce(() => {
      throw new Error("文字层初始化失败");
    });
    const { page, host } = await start();
    const render = renderPdfPage(page, 1, host);
    await expect(render.promise).rejects.toThrow("文字层初始化失败");
    expect(cancelDrawing).toHaveBeenCalledOnce();
    expect(cancelText).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(host.isConnected).toBe(false);
  });

  it("主动取消只执行一次，画布与文字都退出后才清理页面", async () => {
    const pending = deferred();
    renderText.mockReturnValue(pending.promise);
    const { page, host } = await start();
    const render = renderPdfPage(page, 1, host);
    const canvas = host.querySelector("canvas")!;
    render.cancel();
    render.cancel();
    expect(cancelDrawing).toHaveBeenCalledOnce();
    expect(cancelText).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    pending.resolve();
    await render.promise;
    await vi.waitFor(() => expect(canvas.width).toBe(0));
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
