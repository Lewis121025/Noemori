import { computeExport } from "@reader/main/export/computation";
/** @vitest-environment jsdom */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareArtifacts } from "@reader/main/export/pipeline";
import { ExportDocuments, exportOutputNames } from "@reader/main/export/documents";
import { ExportResources } from "@reader/main/export/resources";
import { parseExportHtml, parseInlineExportHtml } from "@reader/renderer/export/html";
import { documentSchema } from "@reader/shared/markdown/schema";
import type { ExportRenderer } from "@reader/main/export/render";
import type { ExportFormat } from "@reader/shared/export";
import { nativeExportFixture } from "../../support/export-native";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
const reporter = { progress: () => {}, plan: () => {} };
function renderer(): ExportRenderer {
  return {
    render: vi.fn<ExportRenderer["render"]>(async (request) => {
      switch (request.kind) {
        case "html":
          return { kind: "html", doc: parseExportHtml(request.source).toJSON() };
        case "inlineHtml":
          return {
            kind: "html",
            doc: parseInlineExportHtml(documentSchema.nodeFromJSON(request.parent)).toJSON(),
          };
        case "pdf":
        case "raster":
          return { kind: "image", data: png, width: 1, height: 1 };
        case "image":
          return { kind: "image", data: request.source, width: 1, height: 1 };
        case "mermaid":
          return { kind: "svg", svg };
        default:
          throw new Error("非预期的测试渲染类型");
      }
    }),
    pdf: vi.fn(async () => new TextEncoder().encode("%PDF-placeholder for pipeline boundary")),
  };
}

describe("EXP-CONTENT 组合内容与失败边界", () => {
  it("PDF 前置转换保留 HTML 中公式来源、图片、Callout、指定 PDF 页和音视频附件", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md":
          '---\nsecret: hidden\n---\n\n%%隐藏注释%%\n\n# 标题\n\n<strong>加粗 $x^2$</strong>\n\n<div><p>块 HTML</p><img src="image.svg"></div>\n\n> [!note]- 折叠提示\n> 必须展开。\n\n![[preview.pdf#page=2]]\n\n![[audio.wav]] ![[video.mp4]]\n\n![[image.svg]]\n\n[目标](b.md#小节) [自身](a.md)\n',
        "b.md": "# 小节\n\n正文。\n",
        "image.svg": svg,
        "preview.pdf": "%PDF-test",
        "audio.wav": "audio",
        "video.mp4": "video",
        "extra.bin": "unreferenced",
      },
      "pdf",
      null,
    );
    const render = renderer();
    const result = await prepareArtifacts(
      fixture.native,
      fixture.request,
      render,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(result).toMatchObject({ single: null, extension: "zip", issues: [] });
    expect(
      vi
        .mocked(render.render)
        .mock.calls.some(([request]) => request.kind === "pdf" && request.page === 2),
    ).toBe(true);
    const calls = vi.mocked(render.pdf).mock.calls;
    expect(calls).toHaveLength(2);
    const first = calls[0];
    if (!first) throw new Error("缺少打印内容");
    const doc = documentSchema.nodeFromJSON(first[0]);
    expect(doc.textContent).toContain("必须展开");
    expect(doc.textContent).toContain("块 HTML");
    expect(doc.textContent).not.toContain("hidden");
    expect(doc.textContent).not.toContain("隐藏注释");
    let images = 0;
    doc.descendants((node) => {
      if (node.type.name === "image") {
        images++;
        expect(node.attrs["src"]).toMatch(/^data:image\//);
      }
    });
    expect(images).toBe(3);
    expect(first[2]?.links).toContainEqual(expect.stringMatching(/^b\.pdf#n/));
    expect(first[2]?.links).not.toContain("#");
    expect(calls[1]?.[2]?.destinations).toHaveLength(1);
    expect(
      await readFile(
        join(fixture.native.snapshot.outputDirectory, "attachments/extra.bin"),
        "utf8",
      ),
    ).toBe("unreferenced");
  });

  it("标题嵌入的内部链接绑定当前产物，行内 HTML 的公式继续携带源码行号", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      { "a.md": "![[b#小节]]\n", "b.md": "# 小节\n\n<strong>$x$</strong>\n\n[内部](#小节)\n" },
      "pdf",
    );
    const render = renderer();
    const signal = new AbortController().signal;
    const documents = new ExportDocuments(
      fixture.native,
      new ExportResources(fixture.native, render, signal, computeExport),
      render,
      "pdf",
      exportOutputNames(["a.md"], "pdf"),
      signal,
      fixture.parse,
    );
    await documents.prepare("a.md");
    await documents.resolveLinks();
    const prepared = await documents.preparedDocuments().next();
    if (prepared.done) throw new Error("缺少文档");
    expect([...prepared.value.formulaLocations.values()]).toEqual([{ path: "b.md", line: 3 }]);
    expect(documents.issues).toEqual([]);
    prepared.value.doc.descendants((node) => {
      for (const mark of node.marks)
        if (mark.type.name === "link") expect(mark.attrs["href"]).toMatch(/^#n/);
    });
  });

  it.for<ExportFormat>(["png", "svg"])(
    "白板单项输出 %s，混合笔记不能误走图像格式",
    async (format, t) => {
      const fixture = await nativeExportFixture(
        t,
        { "board.noemoriboard": '{"version":1,"strokes":[]}' },
        format,
        ["board.noemoriboard"],
      );
      const render = renderer();
      const result = await prepareArtifacts(
        fixture.native,
        fixture.request,
        render,
        new AbortController().signal,
        reporter,
        fixture.parse,
        computeExport,
      );
      expect(result).toMatchObject({ single: `documents/board.${format}`, extension: format });
      const bytes = await readFile(
        join(fixture.native.snapshot.outputDirectory, `documents/board.${format}`),
      );
      expect(format === "png" ? bytes.subarray(1, 4).toString() : bytes.toString()).toContain(
        format === "png" ? "PNG" : 'viewBox="0 0 640 300"',
      );
    },
  );

  it.for<{ format: ExportFormat; files: Record<string, string> }>([
    { format: "png", files: { "a.md": "正文" } },
    { format: "pdf", files: { "image.svg": svg } },
    { format: "markdown", files: { "a.md": "![[missing.png]]" } },
    { format: "markdown", files: { "a.md": "![[b.bin]]", "b.bin": "unknown" } },
    { format: "markdown", files: { "a.md": "%%bad--comment%%" } },
    { format: "markdown", files: { "a.md": "正文[^a]。\n\n[^a]: 循环[^a]。\n" } },
    { format: "markdown", files: { "a.md": "正文[^a]。\n\n[^a]: 一。\n\n[^a]: 二。\n" } },
  ] satisfies { format: ExportFormat; files: Record<string, string> }[])(
    "非法范围或必要内容错误不得生成成功产物：$format $files",
    async ({ format, files }, t) => {
      const fixture = await nativeExportFixture(t, files, format, null);
      await expect(
        prepareArtifacts(
          fixture.native,
          fixture.request,
          renderer(),
          new AbortController().signal,
          reporter,
          fixture.parse,
          computeExport,
        ),
      ).rejects.toThrow();
    },
  );

  it("原格式保留非法 UTF-8 并报告无法扫描引用，HTML 中附件仍收集", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md": new Uint8Array([0xff]),
        "html.md": '<div><img src="image.svg"></div>\n',
        "image.svg": svg,
      },
      "archive",
      ["a.md", "html.md"],
    );
    const result = await prepareArtifacts(
      fixture.native,
      fixture.request,
      renderer(),
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "a.md", severity: "warning" }),
    );
    expect(await readFile(join(fixture.native.snapshot.outputDirectory, "vault/a.md"))).toEqual(
      Buffer.from([0xff]),
    );
    expect(
      await readFile(join(fixture.native.snapshot.outputDirectory, "vault/image.svg"), "utf8"),
    ).toBe(svg);
  });

  it.for(["missing", "changed", "wrong-reply"])(
    "HTML 转换损坏源公式时整体拒绝：%s",
    async (failure, t) => {
      const fixture = await nativeExportFixture(t, { "a.md": "<strong>$x$</strong>\n" }, "pdf");
      const render = renderer();
      vi.mocked(render.render).mockImplementationOnce(async () =>
        failure === "wrong-reply"
          ? { kind: "ready" }
          : {
              kind: "html",
              doc: documentSchema
                .node(
                  "paragraph",
                  null,
                  failure === "missing" ? [] : [documentSchema.node("math_inline", { tex: "y" })],
                )
                .toJSON(),
            },
      );
      await expect(
        prepareArtifacts(
          fixture.native,
          fixture.request,
          render,
          new AbortController().signal,
          reporter,
          fixture.parse,
          computeExport,
        ),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "a.md", severity: "error" })],
      });
    },
  );
});
