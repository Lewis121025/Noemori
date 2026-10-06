import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";
import { ReaderNavigation } from "@reader/renderer/navigation/state.svelte";
import type { CodeEditorApi, MarkdownEditorApi } from "@reader/renderer/editor/editor-api";
import type { SearchHit } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const bytes = new TextEncoder().encode("token then token");
const hit: SearchHit = {
  path: "note.md",
  title: "note",
  snippet: "token",
  contentHash: createHash("sha256").update(bytes).digest("hex"),
  matches: [{ snippet: "token", location: { startByte: 11, endByte: 16, line: 1 } }],
  matchCount: 1,
  matchesCursor: null,
};
function setup() {
  const document = new ReaderDocument(createReaderApiMock());
  document.load(hit.path, { disk: bytes, draft: null });
  const navigation = new ReaderNavigation(document);
  const jump = vi.fn();
  const api: CodeEditorApi = {
    capturePosition: () => null,
    restorePosition: async () => {},
    history: () => false,
    historyAvailability: () => null,
    focus: () => {},
    openSearch: () => {},
    snapshot: () => ({ bytes, revision: 0 }),
    jumpToByte: () => {},
    jumpToSearch: jump,
  };
  const error = vi.fn();
  const open = vi.fn(async () => {});
  return { document, navigation, jump, api, error, open };
}

describe("搜索导航时序", () => {
  it.each(["heading", "mention"])("%s 跳转同样等待文件切换释放，不被早挂载消费", async (kind) => {
    const { document, navigation, api, error } = setup();
    const released = Promise.withResolvers<void>();
    const jump = vi.fn(() => true);
    const surface: MarkdownEditorApi = {
      ...api,
      openAttachments: () => {},
      insertWhiteboard: () => {},
      insertWebPage: () => {},
      settleAttachments: async () => true,
      jumpTo: () => {},
      jumpToMention: jump,
      jumpToHeading: jump,
      currentHeading: () => null,
      visibleHeading: () => null,
    };
    const open = async () => {
      document.load("next.md", { disk: bytes, draft: null });
      navigation.registerMarkdown(surface);
      await released.promise;
    };
    const navigating =
      kind === "heading"
        ? navigation.openHeadingAnchor("next.md", "标题", open, error)
        : navigation.openMention(
            {
              fromPath: "next.md",
              fromTitle: "next",
              mtime: 1,
              startByte: 0,
              endByte: 5,
              snippet: "token",
              kind: "unlinked",
              linkKind: null,
              toRaw: "token",
            },
            open,
          );
    expect(jump).not.toHaveBeenCalled();
    released.resolve();
    await navigating;
    expect(jump).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("新表面在文件切换门禁内挂载时，等切换完成后才交接选区与焦点", async () => {
    const { document, navigation, jump, api, error } = setup();
    const released = Promise.withResolvers<void>();
    const next = { ...hit, path: "next.md" };
    let opening = true;
    const whileOpening: boolean[] = [];
    jump.mockImplementation(() => whileOpening.push(opening));
    const digest = createHash("sha256").update(bytes).digest();
    const spy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new Uint8Array(digest).buffer);
    try {
      const navigating = navigation.openSearchMatch(
        next,
        next.matches[0],
        async () => {
          document.load(next.path, { disk: bytes, draft: null });
          navigation.registerCode(api);
          await released.promise;
          opening = false;
        },
        error,
      );
      // 保持门禁直到挂载和哈希校验的微任务完成，复现表面已存在但仍不可聚焦的阶段。
      await new Promise((resolve) => setTimeout(resolve, 0));
      released.resolve();
      await navigating;
      await vi.waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
      expect(whileOpening).toEqual([false]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("新文件已加载但旧编辑器尚未卸载时，等待新表面注册", async () => {
    const { document, navigation, jump, api, error } = setup();
    navigation.registerCode(api);
    const next = { ...hit, path: "next.md" };
    await navigation.openSearchMatch(
      next,
      next.matches[0],
      async () => {
        document.load(next.path, { disk: bytes, draft: null });
      },
      error,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jump).not.toHaveBeenCalled();
    const nextJump = vi.fn();
    navigation.registerCode({ ...api, jumpToSearch: nextJump });
    await vi.waitFor(() => expect(nextJump).toHaveBeenCalledTimes(1));
  });

  it("切换途中再次点击同一笔记的另一处命中，共用切换等待且只兑现最后选择", async () => {
    const { document, navigation, jump, api, error } = setup();
    const released = Promise.withResolvers<void>();
    const next = { ...hit, path: "next.md" };
    const open = vi.fn(async () => {
      document.load(next.path, { disk: bytes, draft: null });
      navigation.registerCode(api);
      await released.promise;
    });
    const old = navigation.openSearchMatch(next, next.matches[0], open, error);
    const first = { snippet: "token", location: { startByte: 0, endByte: 5, line: 1 } };
    let completed = false;
    const latest = navigation.openSearchMatch(next, first, open, error).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(jump).not.toHaveBeenCalled();
    released.resolve();
    await Promise.all([old, latest]);
    await vi.waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
    expect(jump).toHaveBeenCalledWith(first.location, { bytes, revision: 0 });
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
  it("同一文件尚未挂载时保留具体命中，挂载后定位第二处", async () => {
    const { navigation, jump, api, error, open } = setup();
    await navigation.openSearchMatch(hit, hit.matches[0], open, error);
    expect(jump).not.toHaveBeenCalled();
    navigation.registerCode(api);
    await vi.waitFor(() =>
      expect(jump).toHaveBeenCalledWith(hit.matches[0]?.location, { bytes, revision: 0 }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("编辑器挂载前已选择另一导航，旧搜索不能在注册时复活", async () => {
    const { navigation, jump, api, error, open } = setup();
    await navigation.openSearchMatch(hit, hit.matches[0], open, error);
    navigation.jumpOutline(1);
    const snapshot = vi.fn(api.snapshot);
    navigation.registerCode({ ...api, snapshot });
    expect(snapshot).not.toHaveBeenCalled();
    expect(jump).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("索引版本过期时给出反馈并保留选区", async () => {
    const { navigation, jump, api, error, open } = setup();
    navigation.registerCode(api);
    await navigation.openSearchMatch(
      { ...hit, contentHash: "0".repeat(64) },
      hit.matches[0],
      open,
      error,
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("已变化")));
    expect(jump).not.toHaveBeenCalled();
  });

  it("校验期间切换文档，丢弃旧跳转和错误", async () => {
    const { document, navigation, jump, api, error, open } = setup();
    navigation.registerCode(api);
    const digest = Promise.withResolvers<ArrayBuffer>();
    const spy = vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(digest.promise);
    try {
      await navigation.openSearchMatch(hit, hit.matches[0], open, error);
      document.load("other.md", { disk: bytes, draft: null });
      digest.resolve(new Uint8Array(32).buffer);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(jump).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("内容校验期间用户选择另一处结果，只兑现最新选择", async () => {
    const { navigation, jump, api, error, open } = setup();
    navigation.registerCode(api);
    const digest = Promise.withResolvers<ArrayBuffer>();
    const spy = vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(digest.promise);
    try {
      await navigation.openSearchMatch(hit, hit.matches[0], open, error);
      const first = { snippet: "token", location: { startByte: 0, endByte: 5, line: 1 } };
      await navigation.openSearchMatch(hit, first, open, error);
      await vi.waitFor(() =>
        expect(jump).toHaveBeenCalledWith(first.location, { bytes, revision: 0 }),
      );
      digest.resolve(new Uint8Array(32).buffer);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(jump).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
