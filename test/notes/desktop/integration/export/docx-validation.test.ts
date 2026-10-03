import { computeExport } from "@reader/main/export/computation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { parseMarkdown } from "@reader/shared/markdown/parse";
import { exportDocx } from "@reader/main/export/pandoc";
import { validateDocx } from "@reader/main/export/docx-validation";

let directory: string | undefined;
let parts: Record<string, Uint8Array> = {};
const decoder = new TextDecoder();
const encoder = new TextEncoder();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "noemori-ooxml-validation-"));
  const binary = fileURLToPath(
    new URL(
      "../../../../../modules/notes/packages/desktop/.cache/pandoc-3.12/bundle/pandoc",
      import.meta.url,
    ),
  );
  const bytes = await exportDocx(
    {
      path: "a.md",
      output: "a.docx",
      doc: parseMarkdown("# 文档\n\n[网络链接](https://example.test/docs)\n"),
      anchors: [],
      locations: new Map(),
      formulaLocations: new Map(),
    },
    directory,
    new AbortController().signal,
    computeExport,
    binary,
  );
  parts = unzipSync(bytes);
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("EXP-OOXML 独立产物关系与结构校验", () => {
  it("正文内容类型缺失、错误或重复声明必须拒绝，即使 ZIP 和 XML 均合法", async () => {
    const xml = decoder.decode(parts["[Content_Types].xml"]);
    const declaration = /<Override\b[^>]*PartName="\/word\/document.xml"[^>]*\/>/.exec(xml)?.[0];
    if (!declaration) throw new Error("缺少正文内容类型样本");
    for (const changed of [
      xml.replace(declaration, ""),
      xml.replace(
        declaration,
        declaration.replace(/ContentType="[^"]+"/, 'ContentType="application/xml"'),
      ),
      xml.replace(declaration, declaration + declaration),
    ])
      await expect(
        validateDocx(zipSync({ ...parts, "[Content_Types].xml": encoder.encode(changed) }), 0),
      ).rejects.toThrow("内容类型");
  });

  it("主文档入口必须唯一且指向正文，不能只核对目标文件存在", async () => {
    const xml = decoder.decode(parts["_rels/.rels"]);
    const declaration = /<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*\/>/.exec(xml)?.[0];
    if (!declaration) throw new Error("缺少主文档入口样本");
    for (const changed of [
      xml.replace(declaration, ""),
      xml.replace(declaration, declaration.replace("/officeDocument", "/styles")),
      xml.replace(
        declaration,
        declaration.replace('Target="word/document.xml"', 'Target="word/styles.xml"'),
      ),
      xml.replace(
        declaration,
        declaration + declaration.replace(/Id="[^"]+"/, 'Id="duplicateMain"'),
      ),
    ])
      await expect(
        validateDocx(zipSync({ ...parts, "_rels/.rels": encoder.encode(changed) }), 0),
      ).rejects.toThrow("主文档");
  });

  it("CRC 有效仍须逐个核对媒体来源，替换、丢失和额外媒体都拒绝", async () => {
    const source = encoder.encode("FROZEN-MEDIA-CONTENT");
    const expected = new Set([createHash("sha256").update(source).digest("hex")]);
    parts["[Content_Types].xml"] = encoder.encode(
      decoder
        .decode(parts["[Content_Types].xml"])
        .replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'),
    );
    const archive = zipSync({ ...parts, "word/media/pixel.png": source });
    await expect(validateDocx(archive, 0, [], expected)).resolves.toBeUndefined();
    for (const changed of [
      parts,
      { ...parts, "word/media/pixel.png": encoder.encode("CHANGED-CONTENT") },
      { ...parts, "word/media/pixel.png": source, "word/media/extra.png": new Uint8Array([1]) },
    ])
      await expect(validateDocx(zipSync(changed), 0, [], expected)).rejects.toThrow("媒体字节");
  });
  it("媒体压缩包条目的字节损坏必须被 CRC 校验发现，不能仅检查部件名称存在", async () => {
    const media = encoder.encode("UNIQUE-DOCX-MEDIA-CONTENT");
    const archive = zipSync({ ...parts, "word/media/pixel.png": media }, { level: 0 });
    const index = Buffer.from(archive).indexOf(media);
    expect(index).toBeGreaterThan(0);
    archive[index] = (archive[index] ?? 0) ^ 1;
    await expect(Promise.resolve().then(() => validateDocx(archive, 0))).rejects.toThrow();
  });
  it("原始受控产物通过，合法网络地址中的 Noemori 名称不被误判为内部协议", async () => {
    await expect(validateDocx(zipSync(parts), 0)).resolves.toBeUndefined();
    const relations = decoder.decode(parts["word/_rels/document.xml.rels"]);
    const updated = {
      ...parts,
      "word/_rels/document.xml.rels": encoder.encode(
        relations.replace("https://example.test/docs", "https://example.test/noemori-notes"),
      ),
    };
    await expect(validateDocx(zipSync(updated), 0)).resolves.toBeUndefined();
  });
  it.for([
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
  ])("必要部件或正文使用的关系缺失不能接受：%s", async (name) => {
    const changed = { ...parts };
    delete changed[name];
    await expect(validateDocx(zipSync(changed), 0)).rejects.toThrow();
  });
  it.for([
    (xml: string) => xml.replace("<w:body>", "<w:wrong>").replace("</w:body>", "</w:wrong>"),
    (xml: string) =>
      xml.replace(
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "urn:wrong-word-namespace",
      ),
    (xml: string) => xml.replace(/r:id="[^"]+"/, 'r:id="missing-relationship"'),
    (xml: string) => xml.replace("</w:document>", ""),
    (xml: string) => '<!DOCTYPE w:document [<!ENTITY x "injected">]>' + xml,
  ])("损坏的正文根、命名空间、关系引用和 XML 均拒绝", async (mutate) => {
    const xml = decoder.decode(parts["word/document.xml"]);
    const changed = mutate(xml);
    expect(changed).not.toBe(xml);
    await expect(
      validateDocx(zipSync({ ...parts, "word/document.xml": encoder.encode(changed) }), 0),
    ).rejects.toThrow();
  });
  it.for(["file:///private/secret", "noemori-export-resource:temporary", "/tmp/resource"])(
    "不能交付宿主地址或内部协议关系：%s",
    async (target) => {
      const xml = decoder.decode(parts["word/_rels/document.xml.rels"]);
      await expect(
        validateDocx(
          zipSync({
            ...parts,
            "word/_rels/document.xml.rels": encoder.encode(
              xml.replace("https://example.test/docs", target),
            ),
          }),
          0,
        ),
      ).rejects.toThrow();
    },
  );
  it("相同关系 ID 和包内越界路径都明确拒绝", async () => {
    const xml = decoder.decode(parts["word/_rels/document.xml.rels"]);
    const relationship = /<Relationship\s[^>]+\/>/.exec(xml)?.[0];
    if (!relationship) throw new Error("缺少原生关系样本");
    await expect(
      validateDocx(
        zipSync({
          ...parts,
          "word/_rels/document.xml.rels": encoder.encode(
            xml.replace("</Relationships>", relationship + "</Relationships>"),
          ),
        }),
        0,
      ),
    ).rejects.toThrow();
    await expect(
      validateDocx(zipSync({ ...parts, "../outside.xml": encoder.encode("<a/>") }), 0),
    ).rejects.toThrow();
  });
});
