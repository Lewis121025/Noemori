import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";
import { finalizeExportPdf } from "@reader/main/export/pdf";

const pageUrl = "file:///app/renderer/export.html";
const signal = () => new AbortController().signal;
async function fixture(uris: readonly string[], destination?: string, tagged = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const annotations = uris.map((uri) =>
    pdf.context.register(
      pdf.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 0, 10, 10],
        A: { S: "URI", URI: PDFString.of(uri) },
      }),
    ),
  );
  if (destination) {
    pdf.catalog.set(
      PDFName.of("Dests"),
      pdf.context.obj({ [destination]: [page.ref, "XYZ", 0, 400, null] }),
    );
    annotations.push(
      pdf.context.register(
        pdf.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [0, 0, 1, 1],
          Dest: PDFName.of(destination),
          ...(tagged ? { StructParent: 1 } : {}),
        }),
      ),
    );
  }
  page.node.set(PDFName.of("Annots"), pdf.context.obj(annotations));
  return pdf.save({ addDefaultPage: false });
}
function action(pdf: PDFDocument, index: number): PDFDict {
  const value = pdf
    .getPages()[0]
    ?.node.Annots()
    ?.lookup(index, PDFDict)
    .lookup(PDFName.of("A"), PDFDict);
  if (!value) throw new Error("缺少链接注解");
  return value;
}

describe("EXP-PDF 包内链接、目标和独立产物校验", () => {
  it("本节链接必须同时有注解和真实目标，打印中丢失一侧都拒绝", async () => {
    const original = await fixture([], "chapter");
    const output = await finalizeExportPdf(
      original,
      pageUrl,
      { links: ["#chapter"], destinations: [] },
      signal(),
    );
    expect(output).toBe(original);
    const loaded = await PDFDocument.load(output);
    expect(
      loaded
        .getPages()[0]
        ?.node.Annots()
        ?.lookup(0, PDFDict)
        .lookup(PDFName.of("Dest"), PDFName)
        .decodeText(),
    ).toBe("chapter");
    await expect(
      finalizeExportPdf(
        await fixture([]),
        pageUrl,
        { links: ["#chapter"], destinations: [] },
        signal(),
      ),
    ).rejects.toThrow("缺少正文链接");
    loaded.catalog.delete(PDFName.of("Dests"));
    await expect(
      finalizeExportPdf(
        await loaded.save(),
        pageUrl,
        { links: ["#chapter"], destinations: [] },
        signal(),
      ),
    ).rejects.toThrow("内部链接缺少目标");
  });

  it("外链前缀必须完整匹配，文件名中包含协议字样仍是包内引用", async () => {
    for (const uri of [
      "http://example.test",
      "https://example.test",
      "mailto:reader@example.test",
    ]) {
      const original = await fixture([uri]);
      expect(
        await finalizeExportPdf(original, pageUrl, { links: [uri], destinations: [] }, signal()),
      ).toBe(original);
    }
    await expect(
      finalizeExportPdf(
        await fixture([]),
        pageUrl,
        { links: ["folder/https:note.pdf"], destinations: [] },
        signal(),
      ),
    ).rejects.toThrow("缺少正文链接");
  });
  it("跨文档链接及含括号的附件改成包内相对 URL，外部普通链接保留", async () => {
    const bytes = await fixture([
      "file:///app/renderer/b.pdf#chapter",
      "file:///app/resources/a(1).wav",
      "https://example.test/noemori-help",
    ]);
    const output = await finalizeExportPdf(
      bytes,
      pageUrl,
      {
        links: ["b.pdf#chapter", "../resources/a(1).wav", "https://example.test/noemori-help"],
        destinations: [],
      },
      signal(),
    );
    const pdf = await PDFDocument.load(output);
    expect(action(pdf, 0).lookup(PDFName.of("URI"), PDFHexString).decodeText()).toBe(
      "b.pdf#nameddest=chapter",
    );
    expect(action(pdf, 1).lookup(PDFName.of("URI"), PDFHexString).decodeText()).toBe(
      "../resources/a(1).wav",
    );
    expect(action(pdf, 2).lookup(PDFName.of("URI"), PDFString).decodeText()).toBe(
      "https://example.test/noemori-help",
    );
  });

  it("自文档链接跳到首页，不携带应用安装路径", async () => {
    const bytes = await fixture([`${pageUrl}#`]);
    const pdf = await PDFDocument.load(
      await finalizeExportPdf(bytes, pageUrl, { links: ["#"], destinations: [] }, signal()),
    );
    const self = action(pdf, 0);
    expect(self.lookup(PDFName.of("S"), PDFName).decodeText()).toBe("GoTo");
    expect(self.has(PDFName.of("URI"))).toBe(false);
    expect(self.lookup(PDFName.of("D"), PDFArray).get(0)).toEqual(pdf.getPages()[0]?.ref);
  });

  it("源正文中的必要链接不得在打印中悄悄丢失", async () => {
    await expect(
      finalizeExportPdf(
        await fixture([]),
        pageUrl,
        { links: ["b.pdf"], destinations: [] },
        signal(),
      ),
    ).rejects.toThrow("缺少");
  });

  it("分页探针转为真实目标并移除注解与对象，不改变页数", async () => {
    const output = await finalizeExportPdf(
      await fixture([], "noemori_probe_chapter"),
      pageUrl,
      { links: [], destinations: ["chapter"] },
      signal(),
    );
    const pdf = await PDFDocument.load(output);
    expect(pdf.getPageCount()).toBe(1);
    expect(
      pdf.catalog
        .lookup(PDFName.of("Dests"), PDFDict)
        .keys()
        .map((key) => key.decodeText()),
    ).toEqual(["chapter"]);
    expect(pdf.getPages()[0]?.node.Annots()?.size()).toBe(0);
    expect(Buffer.from(output).toString("latin1")).not.toContain("noemori_probe_");
  });

  it("未冻结地址、错误目标、错误探针和取消明确失败", async () => {
    const empty = await fixture([]);
    for (const uri of ["file:///private/user.md", "noemori-asset:abc"]) {
      await expect(
        finalizeExportPdf(await fixture([uri]), pageUrl, { links: [], destinations: [] }, signal()),
      ).rejects.toThrow("未冻结");
      await expect(
        finalizeExportPdf(empty, pageUrl, { links: [uri], destinations: [] }, signal()),
      ).rejects.toThrow("相对路径");
    }
    await expect(
      finalizeExportPdf(empty, pageUrl, { links: [], destinations: ["absent"] }, signal()),
    ).rejects.toThrow("定位");
    await expect(
      finalizeExportPdf(
        await fixture([], "noemori_probe_chapter", true),
        pageUrl,
        { links: [], destinations: ["chapter"] },
        signal(),
      ),
    ).rejects.toThrow("正文结构");
    const controller = new AbortController();
    controller.abort();
    await expect(
      finalizeExportPdf(empty, pageUrl, { links: [], destinations: [] }, controller.signal),
    ).rejects.toThrow();
    const blank = await PDFDocument.create();
    await expect(
      finalizeExportPdf(
        await blank.save({ addDefaultPage: false }),
        pageUrl,
        { links: [], destinations: [] },
        signal(),
      ),
    ).rejects.toThrow("没有页面");
    await expect(
      finalizeExportPdf(new Uint8Array([1]), pageUrl, { links: [], destinations: [] }, signal()),
    ).rejects.toThrow();
    expect(await finalizeExportPdf(empty, pageUrl, { links: [], destinations: [] }, signal())).toBe(
      empty,
    );
  });
});
