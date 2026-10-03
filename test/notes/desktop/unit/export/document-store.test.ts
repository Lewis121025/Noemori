import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { ExportDocumentStore, type ExportOrigin } from "@reader/main/export/document-store";
import { NativeExport } from "@reader/main/export/native";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import type { Node as PmNode } from "prosemirror-model";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-document-store-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const native = await NativeExport.prepare(
    {
      prepare: async () => ({
        id: "store",
        sourceDirectory: directory,
        outputDirectory: directory,
        files: [],
        directories: [],
        bytes: 0,
        resourceBytes: 0,
        resources: 0,
        sealed: false,
      }),
      action: async (_id, action, bytes) => {
        if (action.action !== "write" || !bytes) throw new Error("意外原生动作");
        const path = join(directory, action.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      },
    },
    { root: "/vault", format: "pdf", scope: { kind: "vault" } },
    "store",
    { cancel: () => true, cancelled: false, progress: {} },
  );
  return { directory, native, store: new ExportDocumentStore(native) };
}

describe("EXP-SNAPSHOT 文档暂存与来源还原", () => {
  it("嵌入来源、相同公式的不同源码行和锚点通过磁盘往返保持独立", async (t) => {
    const { store } = await setup(t);
    const doc = parseMarkdown("# 标题\n\n$x$ 与 $x$\n\n[链接](../原文.md)\n");
    const origins = new WeakMap<PmNode, ExportOrigin>();
    const formulas = new WeakMap<PmNode, { path: string; line: number }>();
    let line = 7;
    doc.descendants((node, position) => {
      origins.set(node, { path: "嵌入/来源.md", position });
      if (node.type.name === "math_inline")
        formulas.set(node, { path: "嵌入/来源.md", line: line++ });
    });
    const source = {
      path: "主文.md",
      output: "documents/主文.pdf",
      doc,
      anchors: [{ position: 0, id: "title" }],
      locations: new Map([["嵌入/来源.md\0" + 0, "title"]]),
      formulaLocations: new Map<PmNode, { path: string; line: number }>(),
    };
    await store.put(source, origins, formulas, "prepared");
    const record = store.records.get(source.path);
    if (!record) throw new Error("暂存记录丢失");
    expect(record).not.toHaveProperty("doc");
    const restoredOrigins = new WeakMap<PmNode, ExportOrigin>();
    const restoredFormulas = new WeakMap<PmNode, { path: string; line: number }>();
    const restored = await store.get(record, restoredOrigins, restoredFormulas);
    expect(restored.doc.eq(doc)).toBe(true);
    expect(restored.doc).not.toBe(doc);
    expect([...restored.formulaLocations.values()]).toEqual([
      { path: "嵌入/来源.md", line: 7 },
      { path: "嵌入/来源.md", line: 8 },
    ]);
    restored.doc.descendants((node, position) =>
      expect(restoredOrigins.get(node)).toEqual({ path: "嵌入/来源.md", position }),
    );
    await store.put(restored, restoredOrigins, restoredFormulas, "resolved");
    expect(store.records.get(source.path)?.file).toMatch(/^working\/resolved\/[a-f0-9]{64}\.json$/);
  });

  it("暂存文件同长度改写不能绕过哈希校验", async (t) => {
    const { store, native, directory } = await setup(t);
    const file = "working/tampered.json";
    await native.write(file, new TextEncoder().encode('{"doc":null,"annotations":[]}'));
    const bytes = await readFile(join(directory, file));
    bytes[0] = 91;
    await writeFile(join(directory, file), bytes);
    await expect(
      store.get(
        { path: "a.md", output: "a.pdf", anchors: [], locations: new Map(), file },
        new WeakMap(),
        new WeakMap(),
      ),
    ).rejects.toThrow("冻结文件内容发生变化");
  });

  it.for([
    { doc: { type: "paragraph" }, annotations: [] },
    {
      doc: parseMarkdown("abc").toJSON(),
      annotations: [{ position: 2, origin: { path: "a.md", position: 1 }, formula: null }],
    },
    {
      doc: parseMarkdown("abc").toJSON(),
      annotations: [0, 0].map(() => ({
        position: 0,
        origin: { path: "a.md", position: 0 },
        formula: null,
      })),
    },
    {
      doc: parseMarkdown("abc").toJSON(),
      annotations: [{ position: 1, origin: { path: "../outside.md", position: 0 }, formula: null }],
    },
    {
      doc: parseMarkdown("abc").toJSON(),
      annotations: [{ position: 0, origin: null, formula: { path: "a.md", line: 1 } }],
    },
    {
      doc: parseMarkdown("abc").toJSON(),
      annotations: [{ position: 0, origin: null, formula: null }],
    },
  ])("结构损坏或不可能的节点来源必须拒绝：%j", async (value, t) => {
    const { store, native } = await setup(t);
    const file = "working/invalid.json";
    await native.write(file, new TextEncoder().encode(JSON.stringify(value)));
    await expect(
      store.get(
        { path: "a.md", output: "a.pdf", anchors: [], locations: new Map(), file },
        new WeakMap(),
        new WeakMap(),
      ),
    ).rejects.toThrow();
  });
});
