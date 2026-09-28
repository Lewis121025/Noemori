import { expect, it } from "vitest";
import {
  parseDraftReply,
  parseDraftRequest,
  parseEditorRecovery,
  parseFileSnapshot,
} from "@reader/shared/editor-recovery";

const bytes = new TextEncoder().encode("original");
const editor = JSON.stringify({
  format: "nous.prosemirror",
  version: 1,
  revision: 2,
  doc: { type: "doc", content: [{ type: "paragraph" }] },
});

it("恢复写入拒绝伪字节、缺失基准和未知版本", () => {
  expect(parseDraftRequest("note.md", bytes, null, editor)).toEqual({
    rel: "note.md",
    source: bytes,
    expected: null,
    editor,
  });
  for (const invalid of [[], {}, "bytes", null])
    expect(() => parseDraftRequest("note.md", invalid, null, editor)).toThrow();
  expect(() => parseDraftRequest("note.md", bytes, undefined, editor)).toThrow();
  expect(() => parseEditorRecovery(editor.replace('"version":1', '"version":2'))).toThrow(
    "恢复记录已保留",
  );
  expect(() => parseEditorRecovery(editor.replace('"revision":2', '"revision":-1'))).toThrow();
  expect(() => parseEditorRecovery("broken")).toThrow("原记录已保留");
});

it("恢复写入只有明确确认才成功，磁盘错误保持业务原因", () => {
  expect(parseDraftReply({ status: "preserved" })).toBeUndefined();
  expect(() => parseDraftReply({ status: "failed", message: "磁盘已满" })).toThrow(/^磁盘已满$/);
  for (const reply of [null, true, {}, { status: "saved" }, { status: "failed" }])
    expect(() => parseDraftReply(reply)).toThrow();
  for (const message of ["", "  "])
    expect(() => parseDraftReply({ status: "failed", message })).toThrow(
      "未收到有效的恢复写入确认",
    );
});

it("加载边界接受旧字节草稿和编辑器草稿，拒绝不完整快照", () => {
  const old = { disk: bytes, draft: { bytes, base: null } };
  expect(parseFileSnapshot(old)).toEqual(old);
  const recovered = {
    disk: null,
    diskError: "父目录不可读",
    draft: { bytes, base: bytes, editor },
  };
  expect(parseFileSnapshot(recovered)).toEqual(recovered);
  for (const value of [
    null,
    {},
    { disk: [], draft: null },
    { disk: bytes, draft: {} },
    { disk: bytes, draft: undefined },
    { disk: null, draft: { bytes, base: bytes, editor: {} } },
  ])
    expect(() => parseFileSnapshot(value)).toThrow();
});
