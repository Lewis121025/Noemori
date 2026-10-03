import { expect, it } from "vitest";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";
import {
  emptyWhiteboard,
  serializeWhiteboard,
  WhiteboardHistory,
} from "@reader/shared/whiteboard/model";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string) => new TextEncoder().encode(text);

it("白板复用保存版本与草稿恢复，坏的外部版本不能替换当前内容", async () => {
  const api = createReaderApiMock();
  const doc = new ReaderDocument(api);
  const baseline = encode(serializeWhiteboard(emptyWhiteboard()));
  doc.load("a.noemoriboard", { disk: baseline, draft: null });
  expect(doc.canEdit).toBe(true);
  const history = new WhiteboardHistory(emptyWhiteboard());
  history.add({ id: "a", width: 2, points: [{ x: 20, y: 30, pressure: 0.5 }] });
  doc.markDirty();
  const edited = encode(serializeWhiteboard(history.document));
  await doc.save(() => ({ bytes: edited, revision: history.revision }));
  expect(api.fileWrite).toHaveBeenCalledWith("a.noemoriboard", edited, baseline);
  expect(doc.dirty).toBe(false);
  const epoch = doc.epoch;
  expect(() => doc.refresh(encode("broken"))).toThrow();
  expect(doc.epoch).toBe(epoch);
  expect(doc.originalBytes).toEqual(edited);
  doc.load("a.noemoriboard", { disk: baseline, draft: { bytes: edited, base: baseline } });
  expect(doc.dirty).toBe(true);
  expect(doc.content).toEqual({ kind: "whiteboard", board: history.document });
});
