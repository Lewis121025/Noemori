import { describe, expect, it } from "vitest";
import {
  libraryEntryKind,
  libraryExcerpt,
  untitledNotePath,
} from "@reader/renderer/library/library";

describe("资料管理与直接记录", () => {
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
  it("预览展示正文，不把属性、HTML 或链接定义当成文章内容", () => {
    expect(
      libraryExcerpt(
        "---\nsecret: 隐藏属性\n---\n\n# 标题\n\n正文 **重点**。\n\n<script>脚本</script>\n\n[ref]: https://example.com\n",
      ),
    ).toEqual(["标题", "正文 重点。"]);
    expect(
      libraryExcerpt(Array.from({ length: 20 }, (_, index) => `第 ${index} 段`).join("\n\n")),
    ).toHaveLength(8);
  });
  it("资料类型遵循文件本身，不把带扩展名的目录当成附件", () => {
    expect(libraryEntryKind({ path: "资料.pdf", kind: "directory" })).toBe("文件夹");
    expect(libraryEntryKind({ path: "资料.PDF", kind: "file" })).toBe("PDF");
    expect(libraryEntryKind({ path: "笔记.md", kind: "file" })).toBe("笔记");
  });
});
