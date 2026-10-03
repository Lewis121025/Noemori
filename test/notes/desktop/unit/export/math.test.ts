import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { documentSchema } from "@reader/shared/markdown/schema";
import { compileExportMath, expectedExportFormulas } from "@reader/main/export/math";
import { equationSignature } from "@reader/main/export/equation-semantics";
import { mathCharacters, wordMathCharacters } from "@reader/main/export/math-characters";
import type { PreparedExportDocument } from "@reader/main/export/documents";

function document(source: string): PreparedExportDocument {
  return {
    path: "a.md",
    output: "a.docx",
    doc: parseMarkdown(source),
    anchors: [],
    locations: new Map(),
    formulaLocations: new Map(),
  };
}

describe("EXP-MATH 独立公式清单和语义", () => {
  it("未知字形、XML 根与数学结构、缺失参数均拒绝，而非跳过验收", () => {
    expect(() => mathCharacters("v", "unknown")).toThrow("字形");
    expect(() => wordMathCharacters("v", "fraktur", "bi")).toThrow("字形");
    for (const body of ["<unknown/>", "<mfrac><mi>x</mi></mfrac>", "<mroot><mi>x</mi></mroot>"])
      expect(() => equationSignature(`<math>${body}</math>`, "mathml")).toThrow();
    for (const source of ["<wrong/>", "<math/><math/>"])
      expect(() => equationSignature(source, "mathml")).toThrow();
    for (const body of ["<m:unknown/>", "<m:r/>", "<m:f><m:num/></m:f>"])
      expect(() => equationSignature(`<m:oMath>${body}</m:oMath>`, "omml")).toThrow();
  });

  it("参数分组、下限、无分数线以及字形区间都参与比较", () => {
    const expected = "<math><munder><mi>x</mi><mo>―</mo></munder></math>";
    const actual = "<m:oMath><m:bar><m:e><m:r><m:t>x</m:t></m:r></m:e></m:bar></m:oMath>";
    expect(equationSignature(actual, "omml")).toBe(equationSignature(expected, "mathml"));
    expect(mathCharacters("ℎℌℬ𝟙𝟏𝟣𝟭𝟷")).toEqual([
      ["letter", "italic", "h"],
      ["letter", "fraktur", "H"],
      ["letter", "script", "B"],
      ["letter", "double-struck", "1"],
      ["letter", "bold", "1"],
      ["letter", "sans-serif", "1"],
      ["letter", "bold-sans-serif", "1"],
      ["letter", "monospace", "1"],
    ]);
  });
  it("期望序列独立于转换器，正文、重复脚注及未引用定义都计数", () => {
    const note = document("$a$ [^b] $c$ [^b]\n\n[^b]: $b$\n\n[^d]: $d$\n");
    const compiled = compileExportMath(note);
    expect(expectedExportFormulas(note, compiled).map((formula) => formula.tex)).toEqual([
      "a",
      "b",
      "c",
      "b",
      "d",
    ]);
    expect(() => expectedExportFormulas(note, compiled.slice(1))).toThrow("编译记录");
    const other = compileExportMath(document("$z$"));
    expect(() => expectedExportFormulas(note, [...compiled, ...other])).toThrow("验收清单");
  });

  it.each([
    "正文[^a]。\n\n[^a]: 自身[^a]。",
    "正文。\n\n[^a]: 引用[^b]。\n\n[^b]: 引用[^a]。",
    "正文[^a]。\n\n[^a]: 定义一。\n\n[^a]: 定义二。",
  ])("异常脚注不能从独立清单中消失：%s", (source) => {
    const note = document(source);
    expect(() => expectedExportFormulas(note, compileExportMath(note))).toThrow("脚注");
  });

  it("冻结模型中的缺失脚注引用明确拒绝，未定义的 Markdown 原文仍按普通文字保留", () => {
    const note = document("正文[^missing]。");
    expect(expectedExportFormulas(note, [])).toEqual([]);
    expect(note.doc.textContent).toContain("[^missing]");
    note.doc = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [
        documentSchema.node("footnote_ref", { label: "missing" }),
      ]),
    ]);
    expect(() => expectedExportFormulas(note, [])).toThrow("脚注缺失");
  });

  it("粗体向量、黑板粗体和 Unicode 数学字母不得退化为普通变量", () => {
    const signature = (body: string) => equationSignature(`<math>${body}</math>`, "mathml");
    expect(signature('<mi mathvariant="bold">v</mi>')).not.toBe(signature("<mi>v</mi>"));
    expect(signature('<mi mathvariant="double-struck">R</mi>')).toBe(signature("<mi>ℝ</mi>"));
    expect(signature("<mi>ℝ</mi>")).not.toBe(signature("<mi>R</mi>"));
    expect(signature("<mi>𝐯</mi>")).toBe(signature('<mi mathvariant="bold">v</mi>'));
    expect(signature("<mn>①</mn>")).not.toBe(signature("<mn>1</mn>"));
  });
});
