/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import "@reader/renderer/export/page";

const io = vi.hoisted(() => ({
  decode: vi.fn(),
  convert: vi.fn(),
  mermaid: vi.fn(),
  initialize: vi.fn(),
  pdf: vi.fn(),
  width: 30,
  height: 20,
}));
vi.mock("@reader/renderer/markdown/views/mathjax-engine", () => ({
  createMathJaxEngine: () => ({ convert: io.convert }),
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: io.initialize,
    render: io.mermaid,
    mermaidAPI: { defaultConfig: { secure: ["securityLevel", "secure"] } },
  },
}));
vi.mock("@reader/renderer/preview/pdf", () => ({ openPdf: io.pdf }));

const encode = (source: string) =>
  `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
const svg = (content = '<rect width="30" height="20"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20">${content}</svg>`;
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=";
const properties: { object: object; name: string; descriptor: PropertyDescriptor | undefined }[] =
  [];
function replace(object: object, name: string, value: unknown): void {
  properties.push({ object, name, descriptor: Object.getOwnPropertyDescriptor(object, name) });
  Object.defineProperty(object, name, { configurable: true, value });
}

beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  io.decode.mockReset().mockResolvedValue(undefined);
  io.convert.mockReset().mockImplementation(async () => document.createElement("span"));
  io.mermaid.mockReset().mockResolvedValue({ svg: svg() });
  io.pdf.mockReset();
  io.initialize.mockClear();
  io.width = 30;
  io.height = 20;
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      get naturalWidth() {
        return io.width;
      }
      get naturalHeight() {
        return io.height;
      }
      decode() {
        return io.decode();
      }
    },
  );
  replace(HTMLImageElement.prototype, "decode", function (this: HTMLImageElement) {
    return io.decode(this.src);
  });
  replace(HTMLImageElement.prototype, "naturalWidth", 30);
  replace(HTMLImageElement.prototype, "naturalHeight", 20);
  replace(document, "fonts", { ready: Promise.resolve() });
  replace(HTMLCanvasElement.prototype, "getContext", () => ({
    fillStyle: "",
    fillRect: () => {},
    drawImage: () => {},
  }));
  replace(HTMLCanvasElement.prototype, "toDataURL", () => png);
});

it("Mermaid 不能在安全清理时丢弃文字，未转为 SVG 文字的标签必须明确失败", async () => {
  io.mermaid.mockResolvedValueOnce({
    svg: svg(
      '<foreignObject width="30" height="20"><div xmlns="http://www.w3.org/1999/xhtml">不能丢失</div></foreignObject>',
    ),
  });
  await expect(
    window.noemoriExport({ kind: "mermaid", source: "graph LR; A[不能丢失]" }),
  ).rejects.toThrow();
});
afterEach(() => {
  for (const item of properties.reverse()) {
    if (item.descriptor) Object.defineProperty(item.object, item.name, item.descriptor);
    else Reflect.deleteProperty(item.object, item.name);
  }
  properties.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EXP-PAGE 隔离页面的资源就绪和故障契约", () => {
  it("真实文档模型完整展开，数学、图片、脚注与锚点全部就绪后才允许打印", async () => {
    const doc = parseMarkdown(
      `# 标题\n\n- [x] 已完成\n- [ ] 未完成\n\n正文 $x^2$ 与脚注[^a]。\n\n![](${encode(svg())})\n\n[^a]: 说明。\n`,
    );
    const reply = await window.noemoriExport({
      kind: "document",
      doc: doc.toJSON(),
      anchors: [{ position: 0, id: "title" }],
    });
    expect(reply).toEqual({ kind: "ready" });
    expect(document.querySelector("#title")?.textContent).toBe("标题");
    expect(document.querySelectorAll("li[data-checked]")).toHaveLength(2);
    expect(document.querySelector("[data-footnote-ref] a")?.getAttribute("href")).toBe(
      "#footnote-a",
    );
    expect(document.querySelector("#footnote-a")?.parentElement?.textContent).toContain("说明");
    expect(io.convert).toHaveBeenCalledWith("x^2", false);
    expect(io.decode).toHaveBeenCalledOnce();
  });

  it("分页目标探针不占据正文行，脚注定位不覆盖已有的导出锚点", async () => {
    const doc = parseMarkdown("# 标题\n\n内容[^a]。\n\n[^a]: 脚注。\n");
    const anchors = [{ position: 0, id: "heading" }];
    doc.descendants((node, position) => {
      if (node.type.name === "footnote_def") anchors.push({ position, id: "note" });
    });
    await window.noemoriExport({
      kind: "document",
      doc: doc.toJSON(),
      anchors,
      destinations: ["heading", "note"],
    });
    for (const id of ["heading", "note"]) {
      const marker = document.querySelector<HTMLElement>(`#noemori_probe_${id}`);
      expect(marker?.style.position).toBe("absolute");
      expect(marker?.parentElement?.id).toBe(id);
      expect(
        document.querySelector(`a[href="#noemori_probe_${id}"]`)?.getAttribute("aria-hidden"),
      ).toBe("true");
    }
    expect(document.querySelector("#footnote-a")?.parentElement?.id).toBe("note");
    await expect(
      window.noemoriExport({
        kind: "document",
        doc: doc.toJSON(),
        anchors,
        destinations: ["missing"],
      }),
    ).rejects.toThrow("目标不存在");
  });

  it("SVG 图像、栅格化、HTML 与 Mermaid 通过受限入口交付", async () => {
    expect(await window.noemoriExport({ kind: "image", source: encode(svg()) })).toMatchObject({
      kind: "image",
      width: 30,
      height: 20,
    });
    expect(await window.noemoriExport({ kind: "raster", source: encode(svg()), scale: 2 })).toEqual(
      { kind: "image", data: png, width: 60, height: 40 },
    );
    expect(
      await window.noemoriExport({ kind: "mermaid", source: "graph LR; A-->B" }),
    ).toMatchObject({ kind: "svg" });
    expect(io.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "neutral", startOnLoad: false }),
    );
    expect(
      await window.noemoriExport({ kind: "html", source: "<strong>正文</strong>", inline: true }),
    ).toMatchObject({ kind: "html" });
    const parent = parseMarkdown("<em>文字 $x$</em>").firstChild;
    if (!parent) throw new Error("缺少行内 HTML 样本");
    expect(
      await window.noemoriExport({ kind: "inlineHtml", parent: parent.toJSON() }),
    ).toMatchObject({ kind: "html" });
  });

  it.for([
    "https://example.test/image.svg",
    "data:image/png;base64,!",
    encode(svg("<script>alert(1)</script>")),
    encode(svg("<foreignObject/>")),
    encode(svg('<rect onclick="run()"/>')),
    encode(svg('<image href="other.png"/>')),
    encode(svg('<style>@import "other.css";</style>')),
    encode(svg("<style>.x{fill:url(other.svg#x)}</style>")),
    encode(svg('<rect fill="url(#missing)"/>')),
    encode(svg('<use href="#missing"/>')),
  ])("不完整或可执行的图像明确失败，不允许离线空白：%s", async (source) => {
    await expect(window.noemoriExport({ kind: "image", source })).rejects.toThrow();
  });

  it("内部 SVG 引用可保留，损坏解码、尺寸、比例和画布失败必须传播", async () => {
    await expect(
      window.noemoriExport({
        kind: "image",
        source: encode(svg('<defs><linearGradient id="paint"/></defs><rect fill="url(#paint)"/>')),
      }),
    ).resolves.toMatchObject({ kind: "image" });
    for (const scale of [0, -1, NaN, Infinity, 4.1])
      await expect(
        window.noemoriExport({ kind: "raster", source: encode(svg()), scale }),
      ).rejects.toThrow("比例");
    io.decode.mockRejectedValueOnce(new Error("decode failed"));
    await expect(window.noemoriExport({ kind: "image", source: encode(svg()) })).rejects.toThrow(
      "decode failed",
    );
    io.width = 20000;
    await expect(window.noemoriExport({ kind: "image", source: encode(svg()) })).rejects.toThrow(
      "尺寸",
    );
    io.width = 30;
    replace(HTMLCanvasElement.prototype, "getContext", () => null);
    await expect(
      window.noemoriExport({ kind: "raster", source: encode(svg()), scale: 1 }),
    ).rejects.toThrow("画布");
  });

  it("SVG 嵌套图片也要离线完整；普通网页超链接不属于加载依赖", async () => {
    const broken = encode(svg('<image href="https://outside.test/missing.png"/>'));
    await expect(
      window.noemoriExport({ kind: "image", source: encode(svg(`<image href="${broken}"/>`)) }),
    ).rejects.toThrow("外部资源");
    const corrupt = "data:image/png;base64,AQID";
    await expect(
      window.noemoriExport({ kind: "image", source: encode(svg(`<image href="${corrupt}"/>`)) }),
    ).rejects.toThrow();
    await expect(
      window.noemoriExport({
        kind: "image",
        source: encode(svg('<a href="https://example.test"><rect width="1" height="1"/></a>')),
      }),
    ).resolves.toMatchObject({ kind: "image" });
    await expect(
      window.noemoriExport({
        kind: "image",
        source: encode(svg('<g id="loop"><use href="#loop"/></g>')),
      }),
    ).rejects.toThrow("循环");
  });

  it("公式错误、超宽、未冻结图片和错误锚点均阻止就绪", async () => {
    const doc = parseMarkdown("正文 $x$\n").toJSON();
    io.convert.mockImplementationOnce(async () => {
      const span = document.createElement("span");
      span.className = "math-error";
      return span;
    });
    await expect(window.noemoriExport({ kind: "document", doc, anchors: [] })).rejects.toThrow(
      "公式无法排版",
    );
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(10000);
    await expect(window.noemoriExport({ kind: "document", doc, anchors: [] })).rejects.toThrow(
      "宽度",
    );
    await expect(
      window.noemoriExport({
        kind: "document",
        doc: parseMarkdown("![](other.png)").toJSON(),
        anchors: [],
      }),
    ).rejects.toThrow("本地化");
    await expect(
      window.noemoriExport({ kind: "document", doc, anchors: [{ position: 0, id: "bad id" }] }),
    ).rejects.toThrow("锚点");
    io.mermaid.mockResolvedValueOnce({ svg: "no diagram" });
    await expect(window.noemoriExport({ kind: "mermaid", source: "invalid" })).rejects.toThrow(
      "SVG",
    );
    document.body.replaceChildren();
    await expect(window.noemoriExport({ kind: "document", doc, anchors: [] })).rejects.toThrow(
      "准备好",
    );
  });

  it("PDF 页码与密码错误释放加载任务，正确指定页完成绘制后释放画布", async () => {
    const destroy = vi.fn(async () => {});
    const render = vi.fn(
      (_request: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }) => ({
        promise: Promise.resolve(),
      }),
    );
    const getPage = vi.fn(async () => ({
      getViewport: () => ({ width: 400, height: 600 }),
      render,
    }));
    io.pdf.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
    expect(await window.noemoriExport({ kind: "pdf", bytes: [1], page: 2 })).toEqual({
      kind: "image",
      data: png,
      width: 400,
      height: 600,
    });
    expect(getPage).toHaveBeenCalledWith(2);
    expect(destroy).toHaveBeenCalledOnce();
    const canvas = render.mock.calls[0]?.[0].canvas;
    expect(canvas?.width).toBe(0);
    expect(canvas?.height).toBe(0);
    for (const page of [0, -1, 1.5, 3])
      await expect(window.noemoriExport({ kind: "pdf", bytes: [1], page })).rejects.toThrow("页码");
    io.pdf.mockImplementation((_bytes: Uint8Array, password: () => void) => {
      password();
      return { promise: new Promise(() => {}), destroy };
    });
    await expect(window.noemoriExport({ kind: "pdf", bytes: [1], page: 1 })).rejects.toThrow(
      "加密 PDF",
    );
    expect(destroy).toHaveBeenCalledTimes(6);
  });
});
