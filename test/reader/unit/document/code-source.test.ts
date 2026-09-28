import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { applyCodeChanges } from "@reader/renderer/engine/document/code-source";
import { utf8ByteToCodeIndex } from "@reader/renderer/engine/document/source-offset";

describe("纯文本编辑的字节契约", () => {
  it("修改一行保留 BOM、混合换行和没有末尾换行", () => {
    const source = "\uFEFF原样\r\n修改\n末尾\r下一行";
    const state = EditorState.create({ doc: source });
    const at = state.doc.toString().indexOf("修改");
    const transaction = state.update({ changes: { from: at, to: at + 2, insert: "改好 👩‍💻" } });
    expect(applyCodeChanges(source, transaction.changes)).toBe(source.replace("修改", "改好 👩‍💻"));
  });

  it("同一事务多处替换采用原坐标，插入行沿用文件的换行方式", () => {
    const source = "第一行\r\n第二行\r\n第三行";
    const state = EditorState.create({ doc: source });
    const transaction = state.update({
      changes: [
        { from: 0, to: 1, insert: "新" },
        { from: state.doc.length, insert: "\n第四行" },
      ],
    });
    expect(applyCodeChanges(source, transaction.changes)).toBe(
      "新一行\r\n第二行\r\n第三行\r\n第四行",
    );
  });

  it("按字节定位跨过 CRLF、BOM 和组合字符时与编辑器坐标一致", () => {
    const source = "\uFEFF👩‍💻\r\né\r定位";
    const prefix = source.slice(0, source.indexOf("定位"));
    const position = utf8ByteToCodeIndex(source, new TextEncoder().encode(prefix).length);
    const state = EditorState.create({ doc: source });
    expect(state.doc.sliceString(position)).toBe("定位");
  });
});
