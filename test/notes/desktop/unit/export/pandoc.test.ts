import { describe, expect, it } from "vitest";
import { toPandoc } from "@reader/main/export/pandoc-document";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { documentSchema } from "@reader/shared/markdown/schema";
import type { Node as PmNode } from "prosemirror-model";

const prepared = (doc: PmNode) => ({
  path: "a.md",
  output: "a.docx",
  doc,
  anchors: [],
  locations: new Map<string, string>(),
  formulaLocations: new Map<PmNode, { path: string; line: number }>(),
});
describe("EXP-DOCX 显式结构映射与前置拒绝", () => {
  it("正文行中的 HTML 行标题保留加粗语义，不降为普通数据单元格", () => {
    const cell = (type: "table_header" | "table_cell", text: string) =>
      documentSchema.node(type, null, documentSchema.text(text));
    const table = documentSchema.node("table", null, [
      documentSchema.node("table_row", null, [cell("table_cell", "值"), cell("table_cell", "数")]),
      documentSchema.node("table_row", null, [
        cell("table_header", "行标题"),
        cell("table_cell", "42"),
      ]),
    ]);
    const result = toPandoc(prepared(documentSchema.node("doc", null, [table])), "/stage");
    expect(JSON.stringify(result.value)).toContain('{"t":"Strong","c":[{"t":"Str","c":"行标题"}]}');
  });
  it("HTML 表格仅将真实表头行映射到表头，无表头时第一行仍是正文", () => {
    const row = (header: boolean, text: string) =>
      documentSchema.node("table_row", null, [
        documentSchema.node(header ? "table_header" : "table_cell", null, [
          documentSchema.text(text),
        ]),
      ]);
    for (const count of [0, 1, 2]) {
      const heads = Array.from({ length: count }, (_, index) => row(true, `表头${index}`));
      const doc = documentSchema.node("doc", null, [
        documentSchema.node("table", null, [...heads, row(false, "第一条数据")]),
      ]);
      const result = toPandoc(prepared(doc), "/stage");
      expect(result.value).toMatchObject({
        blocks: [
          {
            t: "Table",
            c: [
              ["", [], []],
              [null, []],
              [[{ t: "AlignLeft" }, { t: "ColWidthDefault" }]],
              [["", [], []], expect.arrayContaining(heads.map(() => expect.any(Array)))],
              [[["", [], []], 0, [], [expect.any(Array)]]],
              [["", [], []], []],
            ],
          },
        ],
      });
      const serialized = JSON.stringify(result.value);
      expect(serialized.match(/第一条数据/g)).toHaveLength(1);
    }
  });
  it("表格对齐、软换行、图片来源和标题都保留为可编辑结构", () => {
    const source =
      "正文\n第二行\n\n| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 一 | 二 | 三 |\n\n![图片](resources/" +
      "a".repeat(64) +
      '.png "说明")\n';
    const result = toPandoc(
      prepared(parseMarkdown(source)),
      "/stage",
      undefined,
      new Map([[`resources/${"a".repeat(64)}.png`, { width: 120, height: 60 }]]),
    );
    const json = JSON.stringify(result.value);
    for (const name of [
      "SoftBreak",
      "AlignLeft",
      "AlignCenter",
      "AlignRight",
      "Image",
      "说明",
      `/stage/resources/${"a".repeat(64)}.png`,
    ])
      expect(json).toContain(name);
  });
  it.each(["https://example.test/a.png", "../secret.png", "resources/not-a-hash.png"])(
    "未冻结的图片来源不能进入转换引擎：%s",
    (source) => {
      expect(() => toPandoc(prepared(parseMarkdown(`![](${source})`)), "/stage")).toThrow(
        "冻结资源",
      );
    },
  );
  it("丢失的严格公式记录、未转换扩展和非法表格不能伪装成空内容", () => {
    expect(() => toPandoc(prepared(parseMarkdown("$x$")), "/stage", new Map())).toThrow("严格编译");
    for (const source of ["[[未处理]]", "![[嵌入]]", "%%注释%%", "---\ntitle: 属性\n---\n"])
      expect(() => toPandoc(prepared(parseMarkdown(source)), "/stage")).toThrow("不支持");
    expect(() =>
      toPandoc(
        prepared(documentSchema.node("doc", null, [documentSchema.nodes.table!.create()])),
        "/stage",
      ),
    ).toThrow("缺少列");
    const reference = documentSchema.node("footnote_ref", { label: "missing" });
    expect(() =>
      toPandoc(
        prepared(
          documentSchema.node("doc", null, [documentSchema.node("paragraph", null, [reference])]),
        ),
        "/stage",
      ),
    ).toThrow("脚注缺失");
  });
});
