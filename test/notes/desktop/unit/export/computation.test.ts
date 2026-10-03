import { describe, expect, it } from "vitest";
import {
  computeExport,
  packExportDocument,
  parsePreparedDocx,
} from "@reader/main/export/computation";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import type { PreparedExportDocument } from "@reader/main/export/documents";

function note(source: string): PreparedExportDocument {
  const doc = parseMarkdown(source);
  const formulaLocations: PreparedExportDocument["formulaLocations"] = new Map();
  doc.descendants((node) => {
    if (node.type.name === "math_inline" || node.type.name === "math_block")
      formulaLocations.set(node, { path: "folder/source.md", line: 17 });
  });
  return {
    path: "folder/source.md",
    output: "folder/source.docx",
    doc,
    anchors: [{ position: 0, id: "first" }],
    formulaLocations,
    locations: new Map(),
  };
}

describe("EXP-COMPUTE 跨线程转换的内容与来源协议", () => {
  it("正文树的层级约束及每类协议错误都保留明确诊断", async () => {
    const packed = packExportDocument(note("plain"));
    await expect(
      computeExport({
        kind: "checkMath",
        document: {
          ...packed,
          anchors: [],
          doc: { type: "doc", content: [{ type: "text", text: "不能直接位于文档根的文字" }] },
        },
      }),
    ).rejects.toThrow("Invalid content");
    await expect(
      computeExport({
        kind: "checkMath",
        document: { ...packed, anchors: [{ id: "invalid anchor", position: 0 }] },
      }),
    ).rejects.toThrow("导出计算锚点无效");
    const math = packExportDocument(note("$x$"));
    const origin = math.formulas[0];
    if (!origin) throw new Error("缺少公式来源");
    for (const formula of [null, undefined, Object.assign([], origin)])
      await expect(
        computeExport({ kind: "checkMath", document: { ...math, formulas: [formula] } }),
      ).rejects.toThrow("导出计算公式来源无效");
    await expect(
      computeExport({ kind: "checkMath", document: { ...math, formulas: [origin, origin] } }),
    ).rejects.toThrow("导出计算公式来源缺失或重复");
    expect(() => parsePreparedDocx({ input: "{}", media: [], expected: null })).toThrow(
      "导出公式验收清单无效",
    );
    expect(() => parsePreparedDocx({ input: "{}", media: [], expected: [null] })).toThrow(
      "导出公式验收来源无效",
    );
  });

  it("图片显示尺寸的协议拒绝缺失、重复、非数值和超像素预算，支持有效的小数像素", async () => {
    const request = {
      kind: "prepareDocx",
      document: packExportDocument(note("plain")),
      directory: "/stage",
    };
    await expect(computeExport({ ...request, images: null })).rejects.toThrow("图片尺寸清单无效");
    const image = { path: "resources/a.png", width: 10, height: 20 };
    for (const patch of [
      { path: "../outside" },
      { width: 0 },
      { height: -1 },
      { width: "10" },
      { height: NaN },
      { width: 16385 },
      { height: 16385 },
      { width: 8192, height: 4097 },
    ])
      await expect(computeExport({ ...request, images: [{ ...image, ...patch }] })).rejects.toThrow(
        "图片显示尺寸无效",
      );
    for (const patch of [{ width: Infinity }, { height: "20" }, { height: 0 }, { path: 1 }])
      await expect(computeExport({ ...request, images: [{ ...image, ...patch }] })).rejects.toThrow(
        "图片显示尺寸无效",
      );
    for (const images of [[null], [Object.assign([], image)], [image, image]])
      await expect(computeExport({ ...request, images })).rejects.toThrow("图片显示尺寸无效");
    await expect(
      computeExport({ ...request, images: [{ ...image, width: 0.5 }] }),
    ).resolves.toMatchObject({ expected: [], media: [] });
    for (const dimensions of [
      { width: 16384, height: 1 },
      { width: 1, height: 16384 },
      { width: 8192, height: 4096 },
    ])
      await expect(
        computeExport({ ...request, images: [{ ...image, ...dimensions }] }),
      ).resolves.toMatchObject({ expected: [], media: [] });
  });
  it("协议拒绝给出明确原因，不能靠后续属性访问异常碰巧失败", async () => {
    for (const request of [
      null,
      undefined,
      0,
      true,
      "request",
      Object.assign([], { kind: "checkMath", document: packExportDocument(note("x")) }),
    ])
      await expect(computeExport(request)).rejects.toThrow("导出计算请求无效");
    const packed = packExportDocument(note("plain"));
    for (const document of [null, undefined, 0, true, "document", Object.assign([], packed)])
      await expect(computeExport({ kind: "checkMath", document })).rejects.toThrow(
        "导出计算文档无效",
      );
    await expect(
      computeExport({
        kind: "checkMath",
        document: {
          ...packed,
          doc: { type: "paragraph", content: [{ type: "text", text: "plain" }] },
        },
      }),
    ).rejects.toThrow("导出计算正文根无效");
  });

  it("公式位置和来源逐字段检查，非法数值不能穿过协议后才丢失", async () => {
    const packed = packExportDocument(note("$x$"));
    const original = packed.formulas[0];
    if (!original) throw new Error("缺少公式样本");
    for (const patch of [
      { position: -1 },
      { position: 1.5 },
      { position: "1" },
      { position: NaN },
      { position: Infinity },
      { line: -1 },
      { line: 0 },
      { line: 1.5 },
      { line: "1" },
      { line: Infinity },
      { path: "../outside.md" },
      { path: "" },
      { path: null },
    ])
      await expect(
        computeExport({
          kind: "checkMath",
          document: { ...packed, formulas: [{ ...original, ...patch }] },
        }),
      ).rejects.toThrow("导出计算公式来源无效");
    const display = note("$$\nx\n$$");
    display.doc.descendants((node) => {
      if (node.type.name === "math_block")
        display.formulaLocations.set(node, { path: "first.md", line: 1 });
    });
    const prepared = parsePreparedDocx(
      await computeExport({
        kind: "prepareDocx",
        document: packExportDocument(display),
        directory: "/stage",
        images: [],
      }),
    );
    expect(prepared.expected).toMatchObject([
      { display: true, location: { path: "first.md", line: 1 } },
    ]);
  });

  it("非空媒体清单必须由唯一的完整摘要字符串组成", () => {
    const value = { input: "{}", expected: [], media: ["a".repeat(64)] };
    expect(parsePreparedDocx(value)).toEqual(value);
    for (const media of [
      null,
      0,
      "a".repeat(64),
      [new String("a".repeat(64))],
      ["/" + "a".repeat(64)],
      ["a".repeat(64) + "/"],
      ["a".repeat(63)],
      ["A".repeat(64)],
      ["g".repeat(64)],
      ["a".repeat(64), "a".repeat(64)],
    ])
      expect(() => parsePreparedDocx({ ...value, media })).toThrow("DOCX 准备响应无效");
    expect(() => parsePreparedDocx(Object.assign([], value))).toThrow("DOCX 准备响应无效");
  });
  it("公式来源经序列化仍可定位，逐篇执行不会遗留前篇宏", async () => {
    const packed = packExportDocument(note("$\\newcommand{\\foo}{x}\\foo$"));
    const prepared = parsePreparedDocx(
      await computeExport({
        kind: "prepareDocx",
        document: packed,
        directory: "/stage",
        images: [],
      }),
    );
    expect(prepared.expected).toHaveLength(1);
    expect(prepared.expected[0]).toMatchObject({
      display: false,
      location: { path: "folder/source.md", line: 17 },
    });
    expect(prepared.input).toContain("noemori_eq_1");
    expect(prepared.media).toEqual([]);
    await expect(
      computeExport({ kind: "checkMath", document: packExportDocument(note("$\\foo$")) }),
    ).rejects.toMatchObject({
      issues: [
        {
          path: "folder/source.md",
          line: 17,
          severity: "error",
          message: expect.stringContaining("公式无法导出"),
        },
      ],
    });
    await expect(
      computeExport({ kind: "checkMath", document: packExportDocument(note("$x$")) }),
    ).resolves.toBeNull();
  });

  it("Markdown 计算保留正文、资源相对路径与首块锚点", async () => {
    const result = await computeExport({
      kind: "markdown",
      document: packExportDocument(note("中文 [目标](other.md)\n\n![图片](resources/a.png)")),
    });
    expect(result).toBeInstanceOf(Uint8Array);
    if (!(result instanceof Uint8Array)) throw new Error("正文未返回字节");
    const text = new TextDecoder().decode(result);
    expect(text).toContain("中文 [目标](other.md)");
    expect(text).toContain("../resources/a.png");
    expect(text).toContain('<a id="first"></a>');
  });

  it("不能缺失或伪造跨线程正文、公式位置与锚点", async () => {
    const value = packExportDocument(note("$x$"));
    for (const document of [
      null,
      {},
      { ...value, path: "../outside" },
      { ...value, doc: { type: "paragraph" } },
      { ...value, anchors: [{ position: -1, id: "x" }] },
      { ...value, anchors: [{ position: 0, id: "invalid anchor" }] },
      { ...value, formulas: [...value.formulas, ...value.formulas] },
      { ...value, formulas: [{ position: 0, path: "a.md", line: 1 }] },
      { ...value, formulas: [{ position: 1, path: "a.md", line: 0 }] },
    ])
      await expect(computeExport({ kind: "checkMath", document })).rejects.toThrow();
  });

  it("准备结果和计算动作不接受不完整回复", async () => {
    for (const value of [
      null,
      {},
      { input: "{}", expected: [], media: ["not-hash"] },
      { input: "{}", expected: [], media: ["a".repeat(64), "a".repeat(64)] },
      { input: "{}", expected: [null], media: [] },
      {
        input: "{}",
        expected: [{ mathml: "x", display: true, location: { path: "a.md", line: -1 } }],
        media: [],
      },
    ])
      expect(() => parsePreparedDocx(value)).toThrow();
    for (const request of [
      null,
      {},
      { kind: "unknown", bytes: new Uint8Array() },
      { kind: "prepareDocx", document: packExportDocument(note("x")) },
      { kind: "validateDocx", bytes: "invalid", expected: [], media: [] },
      { kind: "validateDocx", bytes: new Uint8Array(), expected: null, media: [] },
      { kind: "validateDocx", bytes: new Uint8Array(), expected: [], media: ["wrong"] },
      {
        kind: "finalizePdf",
        bytes: new Uint8Array(),
        pageUrl: "file:///export.html",
        links: { links: [null], destinations: [] },
      },
    ])
      await expect(computeExport(request)).rejects.toThrow();
  });
});
