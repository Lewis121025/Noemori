import { describe, expect, it } from "vitest";
import { readFileContent } from "@reader/renderer/engine/document/file-content";

const encode = (source: string) => new TextEncoder().encode(source);

describe("文件预览与编辑边界", () => {
  it.each([
    "photo.PNG",
    "photo.jpeg",
    "diagram.svg",
    "animation.gif",
    "photo.webp",
    "photo.avif",
    "photo.bmp",
    "diagram#draft.svg",
    "photo?crop.png",
  ])("%s 只读，保留原始字节", (path) => {
    const bytes = encode("image payload");
    expect(readFileContent(path, bytes)).toEqual({ kind: "image", bytes });
  });

  it.each(["paper.PDF", "download"])("PDF %s 不会变为可编辑源码", (path) => {
    const bytes = encode("%PDF-1.7\n");
    expect(readFileContent(path, bytes)).toEqual({ kind: "pdf", bytes });
  });

  it.each([
    new Uint8Array([0, 1, 2]),
    new Uint8Array([0xff, 0xfe, 65, 0]),
    new Uint8Array([0xc3, 0x28]),
    encode("PK\x03\x04"),
  ])("二进制和不可无损解码的文本保持只读，即使扩展名是 md", (bytes) => {
    expect(readFileContent("note.md", bytes)).toEqual({ kind: "unsupported", bytes });
  });

  it.each([
    ["note.MD", "标题\n\t正文", "markdown"],
    ["unicode.txt", "\f中文 αβ 🌱\u007f\u0080\uffff\u{10ffff}", "text"],
    ["config", "key = value\r\n", "text"],
    ["empty.txt", "", "text"],
    ["diagram.svg#backup.txt", "backup", "text"],
    ["paper.pdf?backup.txt", "backup", "text"],
  ])("%s 仍可作为文本编辑", (path, source, kind) => {
    expect(readFileContent(path, encode(source))).toEqual({ kind, source });
  });

  it.each(Array.from({ length: 32 }, (_, code) => code))(
    "C0 控制字符 %i 保持原有编辑边界",
    (code) => {
      const source = `正文${String.fromCharCode(code)}末尾`;
      const bytes = encode(source);
      expect(readFileContent("note.md", bytes)).toEqual(
        [9, 10, 12, 13].includes(code)
          ? { kind: "markdown", source }
          : { kind: "unsupported", bytes },
      );
    },
  );
});
