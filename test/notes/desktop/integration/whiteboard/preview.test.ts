/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mountNotePreview } from "@reader/renderer/markdown/views/content-view";
import { emptyWhiteboard, serializeWhiteboard } from "@reader/shared/whiteboard/model";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise 尚未初始化");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("初次读取期间发生更新时显示新版本，晚到的旧读取不能覆盖新预览", async () => {
  const first = deferred<Uint8Array>();
  const listeners = new Set<() => void>();
  const updated = {
    ...emptyWhiteboard(),
    strokes: [{ id: "new", width: 2, points: [{ x: 20, y: 30, pressure: 0.5 }] }],
  };
  const bytes = new TextEncoder().encode(serializeWhiteboard(updated));
  const readFile = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(bytes);
  const body = document.createElement("div");
  document.body.append(body);
  const preview = mountNotePreview(body, {
    from: "note.md",
    target: "board.noemoriboard",
    kind: "wiki",
    anchor: null,
    depth: 0,
    chain: ["note.md"],
    openLink: () => {},
    io: {
      resolveLink: async () => "board.noemoriboard",
      readFile,
      createUrl: () => "",
      watchFile: (_path, callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
  });
  try {
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());
    for (const listener of listeners) listener();
    first.resolve(new TextEncoder().encode(serializeWhiteboard(emptyWhiteboard())));
    await vi.waitFor(() => expect(body.querySelectorAll("path")).toHaveLength(1));
    expect(readFile).toHaveBeenCalledTimes(2);
  } finally {
    preview.destroy();
    body.remove();
  }
  expect(listeners.size).toBe(0);
});

it("卸载后迟到的文件结果不重建预览", async () => {
  const pending = deferred<Uint8Array>();
  const body = document.createElement("div");
  const readFile = vi.fn(() => pending.promise);
  const preview = mountNotePreview(body, {
    from: "note.md",
    target: "board.noemoriboard",
    kind: "wiki",
    anchor: null,
    depth: 0,
    chain: ["note.md"],
    openLink: () => {},
    io: { resolveLink: async () => "board.noemoriboard", readFile, createUrl: () => "" },
  });
  await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());
  preview.destroy();
  const before = body.innerHTML;
  pending.resolve(new TextEncoder().encode(serializeWhiteboard(emptyWhiteboard())));
  await pending.promise;
  await Promise.resolve();
  expect(body.innerHTML).toBe(before);
});

it("嵌入预览复用原始笔迹，文件更新后刷新，点击打开来源且销毁后不再更新", async () => {
  let board = emptyWhiteboard();
  let changed: (() => void) | undefined;
  const stop = vi.fn();
  const openLink = vi.fn();
  const body = document.createElement("div");
  document.body.append(body);
  const preview = mountNotePreview(body, {
    from: "note.md",
    target: "草稿.noemoriboard",
    kind: "wiki",
    anchor: null,
    depth: 0,
    chain: ["note.md"],
    openLink,
    io: {
      resolveLink: async () => "草稿.noemoriboard",
      readFile: async () => new TextEncoder().encode(serializeWhiteboard(board)),
      createUrl: () => "",
      watchFile: (_path, callback) => {
        changed = callback;
        return stop;
      },
    },
  });
  try {
    await vi.waitFor(() =>
      expect(body.querySelector("svg")?.getAttribute("aria-label")).toBe("空白白板"),
    );
    const button = body.querySelector<HTMLButtonElement>(".whiteboard-embed-open");
    if (!button) throw new Error("预览未显示");
    button.focus();
    board = {
      ...board,
      strokes: [
        {
          id: "a",
          width: 2,
          points: [
            { x: 0, y: 0, pressure: 0.5 },
            { x: 20, y: 30, pressure: 0.5 },
          ],
        },
      ],
    };
    changed?.();
    await vi.waitFor(() => expect(body.querySelectorAll("path")).toHaveLength(1));
    expect(document.activeElement).toBe(button);
    body.querySelector<HTMLButtonElement>(".whiteboard-embed-open")?.click();
    expect(openLink).toHaveBeenCalledWith("wiki", "草稿.noemoriboard", "note.md");
  } finally {
    preview.destroy();
    body.remove();
  }
  expect(stop).toHaveBeenCalledOnce();
});
