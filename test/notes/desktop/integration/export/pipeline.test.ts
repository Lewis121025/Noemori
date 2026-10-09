import { computeExport } from "@reader/main/export/computation";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareArtifacts } from "@reader/main/export/pipeline";
import type { ExportRenderer } from "@reader/main/export/render";
import { nativeExportFixture } from "../../support/export-native";
import { unzipSync } from "fflate";
import { parseMarkdown } from "@reader/shared/markdown/parse";

const renderer: ExportRenderer = {
  render: async () => {
    throw new Error("此文本样本不应调用渲染页面");
  },
  pdf: async () => {
    throw new Error("此迁移样本不应请求打印");
  },
};
const reporter = { progress: () => {}, plan: () => {} };

const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
const mediaRenderer: ExportRenderer = {
  render: async (request) => {
    if (request.kind === "mermaid") return { kind: "svg", svg: image };
    if (request.kind === "image" || request.kind === "raster")
      return { kind: "image", data: request.source, width: 1, height: 1 };
    throw new Error(`不应渲染此类型：${request.kind}`);
  },
  pdf: async () => new TextEncoder().encode("%PDF-validated by independent desktop test"),
};

describe("EXP-CONTENT 真实冻结源的完整转换", () => {
  it("不同嵌入来源的同名脚注保持独立，不能因为标签相同覆盖内容", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md": "![[left]]\n\n![[right]]\n",
        "left.md": "左正文[^same]。\n\n[^same]: 左脚注 $x$。\n",
        "right.md": "右正文[^same]。\n\n[^same]: 右脚注 $y$。\n",
      },
      "markdown",
    );
    const result = await prepareArtifacts(
      fixture.native,
      fixture.request,
      renderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(result.issues).toEqual([]);
    const output = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/a.md"),
      "utf8",
    );
    for (const content of ["左正文", "右正文", "左脚注", "右脚注", "$x$", "$y$"])
      expect(output).toContain(content);
    const labels = [...output.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]);
    expect(new Set(labels).size).toBe(2);
    for (const match of output.matchAll(/\[\^([^\]]+)\](?!:)/g)) expect(labels).toContain(match[1]);
  });
  it("完整块锚点及嵌入宿主别名都映射到实际输出节点", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md": "[[b#^table]] [[b#^list]] [[b#^quote]] [[b#^host]]\n",
        "b.md":
          "| A | B |\n| - | - |\n| C | D |\n\n^table\n\n- 列表一\n- 列表二\n\n^list\n\n> 引用正文\n\n^quote\n\n![[c]]\n\n^host\n",
        "c.md": "# 嵌入标题\n\n嵌入正文\n",
      },
      "markdown",
      ["a.md", "b.md"],
    );
    const artifacts = await prepareArtifacts(
      fixture.native,
      fixture.request,
      renderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(artifacts.issues).toEqual([]);
    const first = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/a.md"),
      "utf8",
    );
    const target = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/b.md"),
      "utf8",
    );
    const links = [...first.matchAll(/b\.md#([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(links).size).toBe(4);
    for (const id of links) expect(target).toContain(`<a id="${id}"></a>`);
    expect(parseMarkdown(target).textContent).toContain("列表一");
    expect(parseMarkdown(target).textContent).toContain("列表二");
    expect(target).toContain("嵌入正文");
  });
  it("原格式按字节归档依赖和远程副本，普通库外范围链接只报告而不扩展", async (t) => {
    const source =
      "# 原格式\r\n\r\n![[b]]\r\n\r\n![[picture.svg]]\r\n\r\n[音频](audio.wav)\r\n\r\n[[outside]] [[dead]]\r\n\r\n![远程](https://example.test/image.svg)\r\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(image, { headers: { "content-type": "image/svg+xml" } })),
    );
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md": source,
        "b.md": "$\\unknownArchiveCommand$\n",
        "outside.md": "普通链接目标不应递归\n",
        "picture.svg": image,
        "audio.wav": new Uint8Array([1, 2, 3]),
      },
      "archive",
    );
    const artifacts = await prepareArtifacts(
      fixture.native,
      fixture.request,
      mediaRenderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(artifacts.issues.some((issue) => issue.message.includes("outside"))).toBe(true);
    expect(artifacts.issues.some((issue) => issue.message.includes("dead"))).toBe(true);
    const target = join(fixture.directory, "original.zip");
    await fixture.native.target(target);
    await fixture.native.publish(null);
    const contents = unzipSync(await readFile(target));
    expect(contents["vault/a.md"]).toEqual(new TextEncoder().encode(source));
    expect(contents["vault/b.md"]).toEqual(new TextEncoder().encode("$\\unknownArchiveCommand$\n"));
    expect(contents["vault/audio.wav"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(contents["vault/outside.md"]).toBeUndefined();
    expect(
      Object.keys(contents).some(
        (name) => name.startsWith("export/remote/") && name.endsWith(".svg"),
      ),
    ).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(contents["export/manifest.json"]))).toMatchObject({
      version: 1,
      remote: [expect.objectContaining({ url: "https://example.test/image.svg" })],
    });
  });

  it("Markdown 的图片、Mermaid、白板和普通附件引用形成闭合资源包", async (t) => {
    const board = JSON.stringify({ version: 1, strokes: [] });
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md":
          "---\ntitle: 保留属性\n---\n\n%%保留注释%%\n\n![[picture.svg]]\n\n![[board.noemoriboard]]\n\n```mermaid\ngraph LR; A-->B\n```\n\n[附件](audio.wav)\n\n[[dead]]\n",
        "picture.svg": image,
        "board.noemoriboard": board,
        "audio.wav": "original audio",
      },
      "markdown",
    );
    const artifacts = await prepareArtifacts(
      fixture.native,
      fixture.request,
      mediaRenderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    expect(artifacts.single).toBeNull();
    const note = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/a.md"),
      "utf8",
    );
    expect(note).toContain("title: 保留属性");
    expect(note).toContain("<!--保留注释-->");
    expect(note).not.toContain("![[");
    expect(note).not.toContain("```mermaid");
    expect(note).toContain("dead");
    const paths = [...note.matchAll(/\.\.\/(resources\/[a-f0-9]+\.[a-z]+)/g)].map(
      (match) => match[1],
    );
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const path of paths) {
      if (!path) throw new Error("缺少引用路径");
      expect(
        (await readFile(join(fixture.native.snapshot.outputDirectory, path))).length,
      ).toBeGreaterThan(0);
    }
  });
  it.for(["pdf", "docx", "markdown"] as const)(
    "合法空目录仍生成保留层级的 ZIP：%s",
    async (format, t) => {
      const fixture = await nativeExportFixture(
        t,
        { "outside.md": "范围外\n" },
        format,
        ["empty"],
        ["empty/child"],
      );
      const artifacts = await prepareArtifacts(
        fixture.native,
        fixture.request,
        renderer,
        new AbortController().signal,
        reporter,
        fixture.parse,
        computeExport,
      );
      expect(artifacts).toMatchObject({ single: null, extension: "zip", issues: [] });
      const target = join(fixture.directory, "empty.zip");
      expect(await fixture.native.target(target)).toBe(false);
      await fixture.native.publish(null);
      expect(Object.keys(unzipSync(await readFile(target)))).toEqual([
        "documents/",
        "documents/empty/",
        "documents/empty/child/",
      ]);
    },
  );
  it("重复嵌入只保留一份脚注定义，标题嵌入仍携带节外脚注", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      {
        "a.md": "# 主文\n\n![[b#第一节]]\n\n![[b#第一节]]\n",
        "b.md":
          "# 第一节\n\n正文脚注[^one]。\n\n# 第二节\n\n不应包含的第二节。\n\n[^one]: 必须保留的脚注。\n",
      },
      "markdown",
    );
    await prepareArtifacts(
      fixture.native,
      fixture.request,
      renderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    const text = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/a.md"),
      "utf8",
    );
    expect(text.match(/必须保留的脚注/g)).toHaveLength(1);
    expect(text.match(/正文脚注/g)).toHaveLength(2);
    expect(text).not.toContain("不应包含的第二节");
    const definitions = [...text.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]);
    const references = [...text.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((match) => match[1]);
    expect(definitions).toHaveLength(1);
    expect(references.every((reference) => definitions.includes(reference))).toBe(true);
  });

  it("共享高亮语法迁移为标准 HTML，不泄漏 Noemori 扩展标记", async (t) => {
    const fixture = await nativeExportFixture(
      t,
      { "a.md": "# 标题\n\n==需要高亮== 与 **普通粗体**。\n" },
      "markdown",
    );
    await prepareArtifacts(
      fixture.native,
      fixture.request,
      renderer,
      new AbortController().signal,
      reporter,
      fixture.parse,
      computeExport,
    );
    const text = await readFile(
      join(fixture.native.snapshot.outputDirectory, "documents/a.md"),
      "utf8",
    );
    expect(text).toContain('<mark style="background-color: #f6e7a3">需要高亮</mark>');
    expect(text).not.toContain("==需要高亮==");
    expect(text).toContain("**普通粗体**");
  });

  it.for([
    { "a.md": "![[b]]\n", "b.md": "![[a]]\n" },
    {
      "a.md": "![[b]]\n",
      "b.md": "![[c]]\n",
      "c.md": "![[d]]\n",
      "d.md": "![[e]]\n",
      "e.md": "too deep\n",
    },
    { "a.md": "![[missing]]\n" },
    { "a.md": "![[b#不存在的节]]\n", "b.md": "# 正确章节\n" },
  ])("必要嵌入错误明确阻止生成：%j", async (files, t) => {
    const fixture = await nativeExportFixture(t, files, "markdown");
    await expect(
      prepareArtifacts(
        fixture.native,
        fixture.request,
        renderer,
        new AbortController().signal,
        reporter,
        fixture.parse,
        computeExport,
      ),
    ).rejects.toThrow();
  });
});
