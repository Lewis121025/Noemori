/**
 * ReaderApi 的完整测试替身。
 *
 * 默认实现覆盖「恢复库 → 列目录 → 打开文档 → 保存/会话」的最小可用行为；
 * 导航类集成测试（搜索、链接目标、阅读栈）共用本工厂，各自按需覆写字段，
 * 避免每个文件手维护一份三十余个方法的同构 mock。
 */
import { vi } from "vitest";
import type { ReaderApi } from "@reader/shared/api";
import type { LinkTarget, SearchPage } from "@reader/shared/api";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 构造带默认行为的 ReaderApi mock；overrides 浅覆盖对应字段。 */
export function createReaderApiMock(overrides: Partial<ReaderApi> = {}): ReaderApi {
  const api: ReaderApi = {
    vaultRestore: vi.fn(async () => ({
      root: "/notes",
      documents: {
        panes: [{ currentPath: null, history: { back: [], forward: [] } }],
        active: 0,
        split: false,
      },
      viewModes: {},
      recentFiles: [],
      fileTree: null,
    })),
    vaultOpen: vi.fn(async () => null),
    vaultClose: vi.fn(async () => {}),
    vaultList: vi.fn(async () => []),
    vaultEntries: vi.fn(async () => []),
    entryCreate: vi.fn(async () => ({ warning: null })),
    attachmentImport: vi.fn(async () => ({ path: "attachments/a.png", warning: null })),
    entryTrash: vi.fn(async () => ({ warning: null })),
    entryBatch: vi.fn(async () => ({
      completed: [],
      remaining: [],
      skipped: [],
      issues: [],
      warning: null,
    })),
    entryBatchStop: vi.fn(async () => {}),
    entryReveal: vi.fn(async () => {}),
    fileRead: vi.fn(async () => encode("")),
    fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n\n正文。\n"), draft: null })),
    filePreserveDraft: vi.fn(async () => {}),
    fileWrite: vi.fn(async () => ({ status: "saved" as const, warning: null })),
    fileWriteCopy: vi.fn(async () => ({ path: "副本.md", warning: null })),
    sessionSetDocuments: vi.fn(async () => {}),
    sessionSetViewModes: vi.fn(async () => {}),
    sessionSetRecentFiles: vi.fn(async () => {}),
    sessionSetFileTree: vi.fn(async () => {}),
    sessionGetPanes: vi.fn(async () => ({ filesCollapsed: false, leftWidth: 232 })),
    sessionSetPanes: vi.fn(async () => {}),
    linksResolve: vi.fn(async (): Promise<LinkTarget> => ({ status: "dead" })),
    openExternal: vi.fn(async () => {}),
    indexLinksTo: vi.fn(async () => []),
    indexLinksFrom: vi.fn(async () => []),
    indexMentionsTo: vi.fn(async () => ({ linked: [], unlinked: [] })),
    mentionsLinkify: vi.fn(async () => ({ warning: null })),
    searchQuery: vi.fn(async (): Promise<SearchPage> => ({ hits: [], nextCursor: null })),
    searchCancel: vi.fn(async () => {}),
    searchMatches: vi.fn(async () => {
      throw new Error("测试未提供命中续页响应");
    }),
    indexHeadings: vi.fn(async () => []),
    indexTags: vi.fn(async () => []),
    indexNoteKeys: vi.fn(async () => []),
    indexGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
    bookmarksList: vi.fn(async () => []),
    bookmarksSet: vi.fn(async () => {}),
    entryRename: vi.fn(async () => ({ warning: null })),
    subscribeVaultChanged: () => () => {},
  };
  return { ...api, ...overrides };
}
