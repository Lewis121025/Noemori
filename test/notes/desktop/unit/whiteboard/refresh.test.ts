import { expect, it } from "vitest";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";
import { ReaderNavigation } from "@reader/renderer/navigation/state.svelte";
import { WhiteboardInput } from "@reader/renderer/whiteboard/input";
import { emptyWhiteboard, serializeWhiteboard } from "@reader/renderer/whiteboard/model";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

it("后台刷新等待当前笔画，不替用户抬笔；离开门禁仍提交完整笔画", async () => {
  const document = new ReaderDocument(createReaderApiMock());
  const navigation = new ReaderNavigation(document);
  const board = new WhiteboardInput(emptyWhiteboard(), () => {});
  navigation.registerWhiteboard({
    focus: () => {},
    finishInput: () => board.finish(),
    waitForInput: () => board.waitForIdle(),
    snapshot: () => ({
      bytes: new TextEncoder().encode(serializeWhiteboard(board.document)),
      revision: board.revision,
    }),
    history: (action) => {
      board.applyHistory(action);
      return true;
    },
    historyAvailability: () => ({ undo: board.canUndo, redo: board.canRedo }),
  });
  board.begin({ x: 0, y: 0, pressure: 0.5 });
  let refreshed = false;
  const refresh = navigation.settleEditing("refresh").then(() => {
    refreshed = true;
  });
  await Promise.resolve();
  expect(board.active).toBe(true);
  expect(refreshed).toBe(false);
  expect(board.document.strokes).toHaveLength(0);
  board.update({ x: 20, y: 0, pressure: 0.5 });
  board.finish();
  await refresh;
  expect(board.document.strokes[0]?.points.at(-1)?.x).toBe(20);
  board.begin({ x: 30, y: 0, pressure: 0.5 });
  await navigation.settleEditing();
  expect(board.active).toBe(false);
  expect(board.document.strokes).toHaveLength(2);
});

it("空闲等待跨同步接续笔画保持挂起，取消和卸载均能释放等待", async () => {
  const board = new WhiteboardInput(emptyWhiteboard(), () => {});
  const point = { x: 0, y: 0, pressure: 0.5 };
  board.begin(point);
  let idle = false;
  const waiting = board.waitForIdle().then(() => {
    idle = true;
  });
  board.finish();
  board.begin(point);
  await Promise.resolve();
  expect(idle).toBe(false);
  board.cancel();
  await waiting;
  expect(idle).toBe(true);
  board.begin(point);
  const disposed = board.waitForIdle();
  board.dispose();
  await disposed;
  expect(board.active).toBe(false);
});
