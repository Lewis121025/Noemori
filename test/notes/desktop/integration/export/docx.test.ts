import { computeExport } from "@reader/main/export/computation";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { exportDocx } from "@reader/main/export/pandoc";
import { toPandoc } from "@reader/main/export/pandoc-document";
import { validateDocx } from "@reader/main/export/docx-validation";
import type { PreparedExportDocument } from "@reader/main/export/documents";
import { compileExportMath } from "@reader/main/export/math";

const binary = fileURLToPath(
  new URL(
    "../../../../../modules/notes/packages/desktop/.cache/pandoc-3.12/bundle/pandoc",
    import.meta.url,
  ),
);
function document(source: string): PreparedExportDocument {
  return {
    path: "源.md",
    output: "documents/源.docx",
    doc: parseMarkdown(source),
    anchors: [],
    locations: new Map(),
    formulaLocations: new Map(),
  };
}

describe("随包 DOCX 转换与独立结构校验", () => {
  it("图片字节独立核对冻结摘要，媒体被替换但仍是有效图片时也不能交付", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-media-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, "resources"));
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=",
      "base64",
    );
    const hash = createHash("sha256").update(image).digest("hex");
    const path = `resources/${hash}.png`;
    await writeFile(join(directory, path), image);
    const note = document(`开始 ![冻结图片](${path} "图片说明") 中间 ![再次引用](${path}) 结束。`);
    const bytes = await exportDocx(
      note,
      directory,
      new AbortController().signal,
      computeExport,
      binary,
      new Map([[path, { width: 1, height: 1 }]]),
    );
    const parts = unzipSync(bytes);
    const media = Object.entries(parts).filter(([name]) => name.startsWith("word/media/"));
    expect(media).toHaveLength(1);
    expect(media[0]?.[1]).toEqual(new Uint8Array(image));
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
    expect(xml.match(/<wp:extent cx="9525" cy="9525"\s*\/>/g)).toHaveLength(2);
    expect(xml.indexOf("开始")).toBeLessThan(xml.indexOf("中间"));
    expect(xml.indexOf("中间")).toBeLessThan(xml.indexOf("结束"));
    const wrong = `resources/${"0".repeat(64)}.png`;
    await writeFile(join(directory, wrong), image);
    await expect(
      exportDocx(
        document(`![](${wrong})`),
        directory,
        new AbortController().signal,
        computeExport,
        binary,
        new Map([[wrong, { width: 1, height: 1 }]]),
      ),
    ).rejects.toThrow("媒体字节与冻结资源不一致");
  });
  it("行内公式与独立陈列公式保留各自的 Word 排版结构", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-display-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document("行内 $x+y$。\n\n$$\n\\frac{a}{b}\n$$\n");
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml.match(/<m:oMath>/g)).toHaveLength(2);
    expect(xml.match(/<m:oMathPara>/g)).toHaveLength(1);
    expect(xml).toContain('w:name="_noemori_eq_1"');
    expect(xml).toContain('w:name="_noemori_eq_2"');
    const changed = xml.replace("<m:oMathPara>", "").replace("</m:oMathPara>", "");
    await expect(
      validateDocx(
        zipSync({ ...parts, "word/document.xml": new TextEncoder().encode(changed) }),
        2,
        compileExportMath(note),
      ),
    ).rejects.toThrow("陈列");
  });
  it("正文格式、嵌套编号、任务列表、代码和高亮样式均可在 Word 中继续编辑", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-structure-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document(
      "# 结构\n\n**粗体** *斜体* ~~删除线~~ ==高亮== `代码` [网站](https://example.test)\\\n第二行\n\n> 引用段落\n\n---\n\n7. 编号起点\n   - 内层条目\n\n- [x] 已完成\n- [ ] 未完成\n\n```text\n原始代码内容\n```\n",
    );
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml).toContain("<w:strike");
    expect(xml).toContain("<w:br");
    expect(xml).toContain("☑");
    expect(xml).toContain("☐");
    expect(xml).toContain("原始代码内容");
    expect(xml).toContain("编号起点");
    const styles = new TextDecoder().decode(parts["word/styles.xml"]);
    expect(styles).toMatch(
      /<w:style[^>]+w:styleId="NoemoriHighlight"[^>]*>[^]*?<w:highlight w:val="yellow"\s*\/>/,
    );
    expect(xml).toContain('w:rStyle w:val="NoemoriHighlight"');
  });
  it("保留可编辑文字、表格、脚注以及六类原生数学结构", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document(
      [
        "# 中文标题 😀",
        "",
        "保留 **粗体** 和脚注[^a]。",
        "",
        "| 名称 | 数值 |",
        "| --- | --- |",
        "| 数据 | 42 |",
        "",
        "[^a]: 脚注内容。",
        "",
        "$x_i^2$",
        "",
        "$$\\frac{a}{b}$$",
        "",
        "$$\\sqrt{x}$$",
        "",
        "$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$",
        "",
        "$$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$",
        "",
        "$$\\sum_{i=1}^{n}i$$",
        "",
      ].join("\n"),
    );
    expect(toPandoc(note, directory).formulas).toBe(6);
    const bytes = await exportDocx(
      note,
      directory,
      new AbortController().signal,
      computeExport,
      binary,
    );
    const parts = unzipSync(bytes);
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    for (const name of ["sSubSup", "f", "rad", "m", "eqArr", "nary"])
      expect(xml, `缺少数学结构 ${name}`).toMatch(new RegExp(`<m:${name}(?:>| )`));
    expect(xml).toContain("中文标题");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("w:footnoteReference");
    expect(xml).not.toContain("<w:drawing>");
    expect(new TextDecoder().decode(parts["word/footnotes.xml"])).toContain("脚注内容");
    await expect(validateDocx(bytes, 7)).rejects.toThrow("原生公式数量不一致");
    const altered = {
      ...parts,
      "word/document.xml": new TextEncoder().encode(xml.replace("<m:t>x</m:t>", "<m:t>z</m:t>")),
    };
    await expect(validateDocx(zipSync(altered), 6, compileExportMath(note))).rejects.toThrow(
      "结构或内容不一致",
    );
    const relationships = new TextDecoder().decode(parts["_rels/.rels"]);
    const broken = {
      ...parts,
      "_rels/.rels": new TextEncoder().encode(
        relationships.replace('Target="word/document.xml"', 'Target="word/missing.xml"'),
      ),
    };
    await expect(validateDocx(zipSync(broken), 6)).rejects.toThrow("缺少目标部件");
  });

  it("未知数学命令必须失败，不得降为 TeX 文本", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-fail-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await expect(
      exportDocx(
        document("$\\noemoriUnknown{x}$"),
        directory,
        new AbortController().signal,
        computeExport,
        binary,
      ),
    ).rejects.toThrow("公式无法导出");
  });

  it("非文本块的链接目标也写入 Word 书签", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-block-links-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document("> 引用\n\n- 列表\n\n$$x^2$$\n\n---\n\n[定位引用](#target_0)\n");
    note.doc.forEach((_node, offset, index) =>
      note.anchors.push({ position: offset, id: `target_${index}` }),
    );
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    for (const anchor of note.anchors) expect(xml).toContain(`w:name="_${anchor.id}"`);
    expect(xml).toMatch(/<w:hyperlink\b[^>]*w:anchor="_target_0"/);
  });

  it("EXP-MATH 未被引用的脚注正文和公式仍保留，多次引用分别保持原生公式", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-unused-note-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document(
      "正文 $a+b$，两次引用[^used]、[^used]。\n\n[^unused]: 未引用的内容 $c+d$。\n\n[^used]: 已引用的内容 $e+f$。\n",
    );
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const body = new TextDecoder().decode(parts["word/document.xml"]);
    const footnotes = new TextDecoder().decode(parts["word/footnotes.xml"]);
    expect(body).toContain("未引用的内容");
    expect(body.match(/<m:oMath>/g)).toHaveLength(2);
    expect(footnotes.match(/<m:oMath>/g)).toHaveLength(2);
  });

  it("公式错误的嵌入来源和行号进入结构化诊断，界面不必从文字中猜测位置", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-origin-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document("$\\noemoriUnknown{x}$");
    const formula = note.doc.firstChild?.firstChild;
    if (!formula) throw new Error("缺少公式样本");
    note.formulaLocations.set(formula, { path: "嵌入/来源.md", line: 29 });
    await expect(
      exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    ).rejects.toMatchObject({
      issues: [
        {
          path: "嵌入/来源.md",
          line: 29,
          severity: "error",
          message: expect.stringContaining("公式无法导出"),
        },
      ],
    });
  });

  it("宏在单篇文档内按顺序定义和重定义，下一篇文档不能继承", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-macros-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const source =
      "$\\newcommand{\\half}[1]{\\frac{#1}{2}}\\half{x}$\n\n$\\half{y}$\n\n$\\renewcommand{\\half}[1]{\\sqrt{#1}}\\half{z}$\n";
    const bytes = await exportDocx(
      document(source),
      directory,
      new AbortController().signal,
      computeExport,
      binary,
    );
    const xml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"]);
    expect(xml.match(/<m:f>/g)).toHaveLength(2);
    expect(xml.match(/<m:rad>/g)).toHaveLength(1);
    for (const token of ["x", "y", "z", "2"]) expect(xml).toContain(`<m:t>${token}</m:t>`);
    await expect(
      exportDocx(
        document("$\\half{q}$"),
        directory,
        new AbortController().signal,
        computeExport,
        binary,
      ),
    ).rejects.toThrow();
  });

  it("提前取消不启动转换；损坏 ZIP 不作为 DOCX 接受", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportDocx(document("text"), tmpdir(), controller.signal, computeExport, binary),
    ).rejects.toThrow();
    await expect(validateDocx(new Uint8Array([1, 2, 3]), 0)).rejects.toThrow();
  });

  it("EXP-MATH 运算符、分式方向和上下标位置改变时，字符数量相同也必须拒绝", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-semantics-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document("$a+b$\n\n$\\frac{a}{b}$\n\n$x_i^2$\n");
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    const expected = compileExportMath(note);
    const equations = [...xml.matchAll(/<m:oMath>[^]*?<\/m:oMath>/g)].map((match) => match[0]);
    const first = equations[0];
    const second = equations[1];
    if (!first || !second) throw new Error("缺少篡改样本");
    for (const mutated of [
      xml.replace("<m:t>+</m:t>", "<m:t>−</m:t>"),
      xml.replace(/(<m:num>[^]*?<m:t>)a(<\/m:t>[^]*?<m:den>[^]*?<m:t>)b/, "$1b$2a"),
      xml.replace(/(<m:sub>[^]*?<m:t>)i(<\/m:t>[^]*?<m:sup>[^]*?<m:t>)2/, "$12$2i"),
      xml
        .replace(first, "NOEMORI_SWAP_EQUATION")
        .replace(second, first)
        .replace("NOEMORI_SWAP_EQUATION", second),
    ]) {
      expect(mutated).not.toBe(xml);
      const changed = { ...parts, "word/document.xml": new TextEncoder().encode(mutated) };
      await expect(validateDocx(zipSync(changed), expected.length, expected)).rejects.toThrow();
    }
  });

  it("EXP-MATH 复杂数学组合及正文脚注身份分别保持可编辑结构", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-complex-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const formulas = [
      "a-b=c",
      "x^2",
      "x_i",
      "\\frac{a+b}{c-d}",
      "\\sqrt[3]{x+1}",
      "\\int_0^{\\infty} x\\,dx",
      "\\prod_{i=1}^n i",
      "\\lim_{x\\to 0} x",
      "\\left|\\frac{x}{y}\\right|",
      "\\binom{n}{k}",
      "\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}",
      "\\begin{cases}x^2&x>0\\\\-x&x\\le0\\end{cases}",
      "\\begin{aligned}a&=b+c\\\\d&=e-f\\end{aligned}",
      "\\sin x + \\cos y",
      "α+β=γ",
      "\\overline{x}",
      "\\vec{v}",
    ];
    const note = document(
      "正文 $u+v$ 与脚注[^a]。\n\n" +
        formulas.map((source) => `$$\n${source}\n$$`).join("\n\n") +
        "\n\n[^a]: 脚注中的 $p+q$。\n",
    );
    const bytes = await exportDocx(
      note,
      directory,
      new AbortController().signal,
      computeExport,
      binary,
    );
    const parts = unzipSync(bytes);
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml).not.toContain("<w:drawing>");
    expect(new TextDecoder().decode(parts["word/footnotes.xml"])).toContain("noemori_eq_");
    const compiled = compileExportMath(note);
    const first = compiled[0];
    const footnote = compiled.at(-1);
    if (!first || !footnote) throw new Error("缺少来源公式");
    // 脚注在第二个公式位置被引用；其定义写在正文末尾，二者不是相同的遍历顺序。
    await validateDocx(bytes, formulas.length + 2, [first, footnote, ...compiled.slice(1, -1)]);
  });

  it("EXP-MATH 原生数学样式保持向量、集合和字体语义，去掉粗体必须拒绝", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-docx-math-style-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const note = document(
      "$\\boldsymbol{v}$\n\n$\\mathbb{R}$\n\n$\\mathcal{F}$\n\n$\\mathfrak{g}$\n\n$\\mathsf{x}$\n\n$\\mathtt{m}$\n\n$\\mathrm{ABC}$\n\n$\\boldsymbol{\\alpha}$\n\n$ℝ + 𝐯$\n",
    );
    const parts = unzipSync(
      await exportDocx(note, directory, new AbortController().signal, computeExport, binary),
    );
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    const altered = xml.replace('m:sty m:val="bi"', 'm:sty m:val="i"');
    expect(altered).not.toBe(xml);
    await expect(
      exportDocx(
        document("$\\mathbf{v}$"),
        directory,
        new AbortController().signal,
        computeExport,
        binary,
      ),
    ).rejects.toThrow("结构或内容不一致");
    await expect(
      validateDocx(
        zipSync({ ...parts, "word/document.xml": new TextEncoder().encode(altered) }),
        9,
        compileExportMath(note),
      ),
    ).rejects.toThrow("结构或内容不一致");
  });
});
