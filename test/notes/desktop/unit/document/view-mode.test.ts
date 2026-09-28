import { describe, expect, it } from "vitest";
import { ReaderDocument } from "@reader/renderer/document/state.svelte";
import { ReaderNavigation } from "@reader/renderer/navigation/state.svelte";
import type { ReaderApi } from "@reader/shared/api";
import type { EditorSnapshot } from "@reader/renderer/markdown/source-session";
import type { CodeEditorApi, MarkdownEditorApi } from "@reader/renderer/editor/editor-api";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 完整实现两个表面接口，只用快照通道；不靠断言伪造类型。 */
function markdownApi(snapshot: () => EditorSnapshot): MarkdownEditorApi {
  return {
    capturePosition: () => null,
    restorePosition: async () => {},
    history: () => false,
    historyAvailability: () => null,
    openAttachments: () => {},
    insertWhiteboard: () => {},
    settleAttachments: () => Promise.resolve(true),
    focus: () => {},
    openSearch: () => {},
    snapshot,
    jumpTo: () => {},
    jumpToMention: () => {},
    jumpToSearch: () => {},
    jumpToHeading: () => false,
    currentHeading: () => null,
  };
}

function codeApi(snapshot: () => EditorSnapshot): CodeEditorApi {
  return {
    capturePosition: () => null,
    restorePosition: async () => {},
    history: () => false,
    historyAvailability: () => null,
    focus: () => {},
    openSearch: () => {},
    snapshot,
    jumpToByte: () => {},
    jumpToSearch: () => {},
  };
}

function persistenceApi(): Pick<ReaderApi, "fileWrite" | "fileWriteCopy" | "filePreserveDraft"> {
  return {
    fileWrite: () => Promise.resolve({ status: "saved", warning: null }),
    fileWriteCopy: () => Promise.reject(new Error("本测试不应创建副本")),
    filePreserveDraft: () => Promise.resolve(),
  };
}

function loadMarkdown(path = "笔记.md", source = "# 标题\n\n正文。\n"): ReaderDocument {
  const document = new ReaderDocument(persistenceApi());
  document.load(path, { disk: encode(source), draft: null });
  return document;
}

describe("ReaderDocument.replaceSourceText", () => {
  it("替换加载文本并递增代次，保存基准与脏标记保持不变", () => {
    const document = loadMarkdown();
    const epoch = document.epoch;
    const baseline = document.originalBytes;
    document.replaceSourceText("# 标题\n\n视图交接文本。\n");
    expect(document.content).toEqual({ kind: "markdown", source: "# 标题\n\n视图交接文本。\n" });
    expect(document.epoch).toBe(epoch + 1);
    expect(document.originalBytes).toBe(baseline);
    expect(document.dirty).toBe(false);
  });

  it("脏状态跨视图切换保留：切换不是编辑，也不清脏", () => {
    const document = loadMarkdown();
    document.markDirty();
    document.replaceSourceText("编辑中的文本\n");
    expect(document.dirty).toBe(true);
    expect(document.content?.kind).toBe("markdown");
  });

  it("非 Markdown 内容拒绝切换", () => {
    const document = new ReaderDocument(persistenceApi());
    document.load("文本.txt", { disk: encode("plain\n"), draft: null });
    expect(() => document.replaceSourceText("x")).toThrow("只有 Markdown 文档支持切换视图");
  });
});

describe("ReaderNavigation 表面分发", () => {
  const codeStub = codeApi(() => ({ bytes: encode("源码快照"), revision: 3 }));
  const markdownStub = markdownApi(() => ({ bytes: encode("排版快照"), revision: 1 }));

  it("Markdown 源码视图注册在代码通道，快照取代码表面", () => {
    const document = loadMarkdown();
    const navigation = new ReaderNavigation(document);
    navigation.registerCode(codeStub);
    expect(new TextDecoder().decode(navigation.snapshot().bytes)).toBe("源码快照");
    navigation.registerCode(null);
    expect(() => navigation.snapshot()).toThrow("文档编辑器尚未就绪");
  });

  it("排版表面在场时优先走排版通道", () => {
    const document = loadMarkdown();
    const navigation = new ReaderNavigation(document);
    navigation.registerMarkdown(markdownStub);
    navigation.registerCode(codeStub);
    expect(new TextDecoder().decode(navigation.snapshot().bytes)).toBe("排版快照");
  });
});
