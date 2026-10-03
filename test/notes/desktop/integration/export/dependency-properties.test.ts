import { computeExport } from "@reader/main/export/computation";
import { describe, expect, it, vi } from "vitest";
import { ExportDocuments, exportOutputNames } from "@reader/main/export/documents";
import { ExportResources } from "@reader/main/export/resources";
import type { ExportRenderer } from "@reader/main/export/render";
import { nativeExportFixture } from "../../support/export-native";

describe("EXP-PROPERTY 依赖闭包和同源去重", () => {
  it("一千组固定种子的菱形嵌入收集完整依赖，重复正文不变成重复源文件", async (t) => {
    const files: Record<string, string> = {};
    const roots: string[] = [];
    const expected = new Map<string, number>();
    let state = 20260301;
    for (let sample = 0; sample < 1000; sample++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const group = state % 37;
      const root = `roots/a${sample}.md`;
      roots.push(root);
      expected.set(root, group);
      files[root] = `# 根${sample}\n\n![[deps/b${group}.md]]\n\n![[deps/c${group}.md]]\n`;
      files[`deps/b${group}.md`] = `B${group}\n\n![[d${group}]]\n`;
      files[`deps/c${group}.md`] = `C${group}\n\n![[d${group}]]\n`;
      files[`deps/d${group}.md`] = `共同依赖${group}结束\n`;
    }
    const fixture = await nativeExportFixture(t, files, "markdown", roots);
    const signal = new AbortController().signal;
    const render: ExportRenderer = {
      render: async () => {
        throw new Error("不应渲染");
      },
      pdf: async () => {
        throw new Error("不应打印");
      },
    };
    const documents = new ExportDocuments(
      fixture.native,
      new ExportResources(fixture.native, render, signal, computeExport),
      render,
      "markdown",
      exportOutputNames(roots, "markdown"),
      signal,
      fixture.parse,
    );
    for (const root of roots) await documents.prepare(root);
    await documents.resolveLinks();
    await fixture.native.seal();
    expect(documents.issues).toEqual([]);
    expect(fixture.native.snapshot.files.map((file) => file.path).sort()).toEqual(
      Object.keys(files).sort(),
    );
    let count = 0;
    for await (const document of documents.preparedDocuments()) {
      const group = expected.get(document.path);
      expect(document.doc.textContent.match(new RegExp(`共同依赖${group}结束`, "g"))).toHaveLength(
        2,
      );
      const anchors = new Set(document.anchors.map((anchor) => anchor.id));
      expect(anchors.size).toBe(document.anchors.length);
      for (const id of document.locations.values()) expect(anchors.has(id)).toBe(true);
      count++;
    }
    expect(count).toBe(1000);
  }, 60000);

  it("一千组重复 data 图片请求共享生成结果，不能出现竞态重复写入", async (t) => {
    const fixture = await nativeExportFixture(t, { "a.md": "正文" }, "markdown");
    const render: ExportRenderer = {
      render: vi.fn<ExportRenderer["render"]>(async (request) => {
        if (request.kind !== "image") throw new Error("只应检查静态图片");
        return { kind: "image", data: request.source, width: 1, height: 1 };
      }),
      pdf: async () => {
        throw new Error("不应打印");
      },
    };
    const resources = new ExportResources(
      fixture.native,
      render,
      new AbortController().signal,
      computeExport,
    );
    const sources = new Set<string>();
    let seed = 19491001;
    for (let sample = 0; sample < 1000; sample++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const source = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><text>${seed % 31}</text></svg>`).toString("base64")}`;
      sources.add(source);
      const [first, second] = await Promise.all([resources.image(source), resources.image(source)]);
      expect(second).toBe(first);
      expect(await resources.imageData(first.path)).toBe(source);
    }
    expect(render.render).toHaveBeenCalledTimes(sources.size);
    expect(resources.images.size).toBe(sources.size);
  }, 30000);
});
