import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { findBlockPmPos } from "@reader/renderer/engine/navigation/block-anchor";
import {
  listDocBlocks,
  listSourceBlocks,
  newBlockId,
  takenBlockIds,
  withBlockId,
} from "@reader/renderer/engine/navigation/block-list";

const source = [
  "---",
  "title: x",
  "---",
  "",
  "# 标题不是块",
  "",
  "第一段 **加粗** 文字。",
  "",
  "带 ID 的段落 ^old-1",
  "",
  "- 列表项甲",
  "- 列表项乙",
  "",
  "> 引用里的段落",
  "",
  "表格前一段",
  "",
  "^standalone",
  "",
].join("\n");

describe("块清单", () => {
  it("源码清单覆盖段落、列表项与引用，识别两种 ID 写法，标题与 frontmatter 不算块", () => {
    const blocks = listSourceBlocks(source);
    expect(blocks.map((block) => [block.text, block.id])).toEqual([
      ["第一段 加粗 文字。", null],
      ["带 ID 的段落", "old-1"],
      ["列表项甲", null],
      ["列表项乙", null],
      ["引用里的段落", null],
      ["表格前一段", "standalone"],
    ]);
    expect(source.slice(0, blocks[0]!.insertAt).endsWith("文字。")).toBe(true);
    expect(source.slice(0, blocks[2]!.insertAt).endsWith("列表项甲")).toBe(true);
  });

  it("文档清单与源码清单一致，未保存的编辑也在其中", () => {
    const doc = parseMarkdown(source);
    expect(listDocBlocks(doc).map((block) => [block.text, block.id])).toEqual(
      listSourceBlocks(source).map((block) => [block.text, block.id]),
    );
  });

  it("BOM 不影响插入偏移", () => {
    const withBom = `\uFEFF段落\n`;
    const [block] = listSourceBlocks(withBom);
    expect(withBlockId(withBom, block!, "abc123")).toBe("\uFEFF段落 ^abc123\n");
  });
});

describe("块 ID", () => {
  it("生成 6 位 base36 且避开已有 ID", () => {
    const sequence = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let index = 0;
    const id = newBlockId(new Set(["000000"]), () => sequence[index++] ?? 0.1);
    expect(id).toBe("iiiiii");
    expect(newBlockId(new Set())).toMatch(/^[0-9a-z]{6}$/);
  });

  it("写入只在段落末尾追加，写入后的 ID 能被跳转识别", () => {
    const blocks = listSourceBlocks(source);
    const target = blocks[2]!;
    const id = newBlockId(takenBlockIds(blocks));
    const next = withBlockId(source, target, id);
    expect(next.replace(` ^${id}`, "")).toBe(source);
    expect(next).toContain(`- 列表项甲 ^${id}\n`);
    expect(listSourceBlocks(next)[2]?.id).toBe(id);
    expect(findBlockPmPos(parseMarkdown(next), id)).not.toBeNull();
  });
});
