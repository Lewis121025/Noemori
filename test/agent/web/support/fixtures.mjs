import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(
  new URL("../../../../modules/agent/web-runtime/package.json", import.meta.url),
);
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const cjkFont =
  process.env.NOEMORI_TEST_CJK_FONT || "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
if (existsSync(cjkFont)) GlobalFonts.registerFromPath(cjkFont, "TestCJK");

/** 在内存生成最小 PDF，文本页与扫描页共用真实的 PDF.js 解析路径。 */
export function pdfFixture(pages) {
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.alloc(0),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const pageIds = [];
  const add = (body) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    return objects.length;
  };
  const stream = (dictionary, bytes) =>
    Buffer.concat([
      Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
      bytes,
      Buffer.from("\nendstream"),
    ]);
  for (const kind of pages) {
    let imageId;
    let commands;
    if (kind === "text") {
      commands = Buffer.from("BT /F1 18 Tf 25 350 Td (Release notes: keep code and tables.) Tj ET");
    } else {
      const canvas = createCanvas(600, 800);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 600, 800);
      context.fillStyle = "black";
      context.font = "36px TestCJK";
      context.fillText("扫描 PDF 测试", 40, 80);
      context.font = "22px TestCJK";
      context.fillText("上下文保留必要信息，错误必须明确反馈。", 40, 140);
      context.fillText("Small text: version 1.2.3, API response.", 40, 195);
      imageId = add(
        stream(
          "/Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          canvas.toBuffer("image/jpeg", 95),
        ),
      );
      commands = Buffer.from("q 300 0 0 400 0 0 cm /Scan Do Q");
      if (kind === "hybrid")
        commands = Buffer.concat([commands, Buffer.from(" BT /F1 10 Tf 140 15 Td (page 1) Tj ET")]);
    }
    const contentId = add(stream("", commands));
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Scan ${imageId} 0 R >>` : ""} >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );
  const chunks = [Buffer.from("%PDF-1.7\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((object, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(chunks));
}
