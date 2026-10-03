import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import {
  exportOutputNames,
  portableMarkdown,
  type PreparedExportDocument,
} from "@reader/main/export/documents";

function prepared(source: string): PreparedExportDocument {
  const doc = parseMarkdown(source);
  const anchors: PreparedExportDocument["anchors"] = [];
  doc.descendants((node, position) => {
    if (node.isTextblock) anchors.push({ position, id: `a${anchors.length + 1}` });
  });
  return {
    path: "a.md",
    output: "documents/a.md",
    doc,
    anchors,
    locations: new Map(),
    formulaLocations: new Map(),
  };
}

describe("通用 Markdown 及全局输出映射", () => {
  it("位置零属于首个正文块，不能将文档根误当作标题并丢弃全文", () => {
    const output = portableMarkdown(prepared("# 标题\n\n必须保留的正文\n"));
    expect(output).toContain('# <a id="a1"></a>标题');
    expect(output).toContain("必须保留的正文");
  });
  it("列表、代码、表格和公式中的内容都保留", () => {
    const output = portableMarkdown(
      prepared(
        "# A\n\n- 项目一\n- 项目二\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| C | D |\n\n$\\frac{1}{2}$\n",
      ),
    );
    for (const value of ["项目一", "项目二", "const x = 1", "C", "D", "\\frac{1}{2}"])
      expect(output).toContain(value);
  });
  it("输出名称对选择次序保持确定，大小写冲突获得稳定后缀", () => {
    const paths = ["目录/A.md", "目录/a.MD", "别处/a.md"];
    const first = exportOutputNames(paths, "pdf");
    expect([...first]).toEqual([...exportOutputNames([...paths].reverse(), "pdf")]);
    expect(new Set([...first.values()].map((path) => path.toLowerCase())).size).toBe(3);
  });
  it("Unicode 完整大小写折叠冲突也避让，不能在 macOS 解压时覆盖其他文档", () => {
    for (const [left, right] of [
      ["straße.md", "STRASSE.md"],
      ["σ.md", "ς.md"],
      ["ſ.md", "s.md"],
    ]) {
      if (!left || !right) throw new Error("缺少名称样本");
      const outputs = [...exportOutputNames([left, right], "pdf").values()];
      expect(outputs.some((value) => /-[a-f0-9]{12}\.pdf$/.test(value))).toBe(true);
    }
    expect([...exportOutputNames(["ı.md", "I.md"], "pdf").values()]).toEqual([
      "documents/I.pdf",
      "documents/ı.pdf",
    ]);
  });
  it("文件与目录的扩展名冲突、目录大小写及 Unicode 冲突都稳定避让", () => {
    const paths = ["A.md", "A.pdf/note.md", "Case/x.md", "case/y.md", "é/a.md", "e\u0301/b.md"];
    const mapped = exportOutputNames(paths, "pdf");
    const normalize = (name: string) => name.normalize("NFC").toLowerCase();
    const files = [...mapped.values()].map(normalize);
    for (const file of files)
      expect(files.some((other) => other.startsWith(file + "/"))).toBe(false);
    const parent = (path: string) =>
      normalize(mapped.get(path)?.split("/").slice(0, -1).join("/") ?? "");
    expect(parent("Case/x.md")).not.toBe(parent("case/y.md"));
    expect(parent("é/a.md")).not.toBe(parent("e\u0301/b.md"));
    expect([...mapped]).toEqual([...exportOutputNames([...paths].reverse(), "pdf")]);
  });
  it("一千组固定种子样本保留所有内容标记和次序", () => {
    let state = 19491001;
    for (let sample = 0; sample < 1000; sample++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const labels = Array.from({ length: (state % 9) + 1 }, (_, i) => `标记${sample}x${i}`);
      const blocks = labels.map(
        (label, i) =>
          [label, `## ${label}`, `- ${label}`, `> ${label}`, `**${label}**`][(state + i) % 5] ??
          label,
      );
      const output = portableMarkdown(prepared(blocks.join("\n\n")));
      let previous = -1;
      for (const label of labels) {
        const index = output.indexOf(label);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });
});
