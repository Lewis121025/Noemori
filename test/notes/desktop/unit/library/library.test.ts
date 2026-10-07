import { describe, expect, it } from "vitest";
import {
  libraryEntryKind,
  untitledNotePath,
  untitledWhiteboardPath,
} from "@reader/renderer/library/library";

describe("资料管理与直接记录", () => {
  it("白板创建沿用同一套文件、目录和大小写冲突规则", () => {
    expect(
      untitledWhiteboardPath(
        [
          { path: "资料/白板.noemoriboard", kind: "file" },
          { path: "资料/白板 2.NOEMORIBOARD", kind: "directory" },
        ],
        "资料",
      ),
    ).toBe("资料/白板 3.noemoriboard");
    expect(untitledWhiteboardPath([], "")).toBe("白板.noemoriboard");
  });
  it("新笔记避开文件与文件夹占用，沿用当前目录而不覆盖已有内容", () => {
    expect(
      untitledNotePath(
        [
          { path: "资料/未命名.md", kind: "file" },
          { path: "资料/未命名 2.MD", kind: "directory" },
        ],
        "资料",
      ),
    ).toBe("资料/未命名 3.md");
    expect(untitledNotePath([], "")).toBe("未命名.md");
  });
  it("资料类型遵循文件本身，不把带扩展名的目录当成附件", () => {
    expect(libraryEntryKind({ path: "资料.pdf", kind: "directory" })).toBe("文件夹");
    expect(libraryEntryKind({ path: "资料.PDF", kind: "file" })).toBe("PDF");
    expect(libraryEntryKind({ path: "笔记.md", kind: "file" })).toBe("笔记");
  });
});
