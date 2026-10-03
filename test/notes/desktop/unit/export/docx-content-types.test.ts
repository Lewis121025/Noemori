import { describe, expect, it } from "vitest";
import { validateDocxContentTypes } from "@reader/main/export/docx-content-types";

const prefix = "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const root = (children: string) =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${children}</Types>`;
const override = (name: string, type: string) =>
  `<Override PartName="/${name}" ContentType="${type}"/>`;
const fallback = (extension: string, type: string) =>
  `<Default Extension="${extension}" ContentType="${type}"/>`;
const relationships = fallback("rels", "application/vnd.openxmlformats-package.relationships+xml");
const document = override("word/document.xml", `${prefix}document.main+xml`);
const names = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);

describe("EXP-OOXML 内容类型与真实部件逐项对应", () => {
  it("根关系、默认扩展名大小写及按部件覆盖的优先级遵守 OPC 规则", () => {
    const parts = new Set([...names, "word/media/image.PNG", "word/", "word/media/"]);
    const xml = root(
      relationships + document + fallback("xml", "application/xml") + fallback("png", "image/png"),
    );
    expect(() => validateDocxContentTypes(xml, parts)).not.toThrow();
    expect(() =>
      validateDocxContentTypes(xml.replace('Extension="png"', 'Extension="PNG"'), parts),
    ).not.toThrow();
  });

  it.each([
    ["styles", "styles"],
    ["numbering", "numbering"],
    ["footnotes", "footnotes"],
    ["endnotes", "endnotes"],
    ["settings", "settings"],
    ["fontTable", "fontTable"],
    ["webSettings", "webSettings"],
  ])("Word 的 %s 部件不能伪装成普通 XML", (name, suffix) => {
    const part = `word/${name}.xml`;
    const parts = new Set([...names, part]);
    const xml = root(relationships + document + override(part, `${prefix}${suffix}+xml`));
    expect(() => validateDocxContentTypes(xml, parts)).not.toThrow();
    expect(() =>
      validateDocxContentTypes(xml.replace(`${prefix}${suffix}+xml`, "application/xml"), parts),
    ).toThrow("内容类型");
  });

  it("默认类型不能覆盖必需类型；没有扩展名的部件须显式声明", () => {
    const parts = new Set([...names, "word/custom"]);
    expect(() => validateDocxContentTypes(root(relationships + document), parts)).toThrow(
      "内容类型",
    );
    expect(() =>
      validateDocxContentTypes(
        root(relationships + document + override("word/custom", "application/octet-stream")),
        parts,
      ),
    ).not.toThrow();
    expect(() =>
      validateDocxContentTypes(root(relationships + fallback("xml", "application/xml")), names),
    ).toThrow("内容类型");
    expect(() =>
      validateDocxContentTypes(root(document + fallback("rels", "application/xml")), names),
    ).toThrow("内容类型");
  });

  it.each([
    '<Default Extension="png"/>',
    '<Default Extension="png" ContentType=""/>',
    '<Default ContentType="image/png"/>',
    '<Default Extension="../png" ContentType="image/png"/>',
    '<Default Extension="png" ContentType="image/png extra"/>',
    '<Override ContentType="application/xml"/>',
    '<Override PartName="word/document.xml" ContentType="application/xml"/>',
    override("absent.xml", "application/xml"),
    override("word/", "application/xml"),
    fallback("rels", "application/xml"),
    fallback("RELS", "application/xml"),
    document,
    override("word/%64ocument.xml", `${prefix}document.main+xml`),
  ])("错误或重复声明不能通过：%s", (extra) => {
    expect(() =>
      validateDocxContentTypes(
        root(relationships + document + extra),
        new Set([...names, "word/"]),
      ),
    ).toThrow("内容类型");
  });

  it("没有类型表和空类型表均不能满足实际部件", () => {
    for (const xml of ["", "<Invalid/>", "<Types/>", root("")])
      expect(() => validateDocxContentTypes(xml, names)).toThrow("内容类型");
  });
});
