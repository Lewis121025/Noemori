import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as NativeModule from "@nous/native";
import type {
  Bookmark,
  FileSnapshot,
  HeadingRecord,
  LinkKind,
  LinkRecord,
  LinkTarget,
  Mentions,
  NoteKeys,
  RenameOutcome,
  SavedCopy,
  SearchExpr,
  SearchHit,
  SearchQuery,
  TagCount,
  VaultRestore,
  WriteResult,
  VaultEntry,
  VaultEvent,
  VaultGraph,
} from "../shared/api";
import { parseVaultEvent } from "../shared/api";
import { parseAttachmentRequest, parseImportedAttachment } from "../shared/attachments";
import { parseDraftRequest } from "../shared/editor-recovery";
import type {
  HistoryEntry,
  ReaderSession,
  ReaderSessionStore,
  SessionDocuments,
  SessionHistory,
} from "../shared/session";
import { emptySessionDocuments, mapPathList, mapViewModes } from "../shared/session";
import {
  parseBookmarks,
  parseGraph,
  parseEntryOutcome,
  parseFileBytes,
  parseHeadingRecords,
  parseLinkRecords,
  parseLinkTarget,
  parseMentions,
  parseNoteKeys,
  parseSearchHits,
  parseSearchQueryArgument,
  parseTagCounts,
  parseWriteResult,
  parseSavedCopy,
} from "../shared/reader-protocol";

const require = createRequire(import.meta.url);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mapLink(link: NativeModule.JsLinkRecord) {
  return {
    fromPath: link.fromPath,
    toRaw: link.toRaw,
    toPath: link.toPath ?? null,
    kind: link.kind,
    resolution: link.resolution,
    startByte: link.startByte,
    endByte: link.endByte,
  };
}

function mapMention(mention: NativeModule.JsMentionRecord) {
  return {
    fromPath: mention.fromPath,
    fromTitle: mention.fromTitle,
    mtime: mention.mtime,
    startByte: mention.startByte,
    endByte: mention.endByte,
    snippet: mention.snippet,
    kind: mention.kind,
    linkKind: mention.linkKind ?? null,
    toRaw: mention.toRaw,
  };
}

/**
 * 检索表达式转为原生层的扁平节点结构。
 *
 * exactOptionalPropertyTypes：缺省字段必须省略键，不能传 undefined。
 */
function nativeSearchExpr(expr: SearchExpr): NativeModule.JsSearchExpr {
  switch (expr.kind) {
    case "and":
    case "or":
      return { kind: expr.kind, children: expr.children.map(nativeSearchExpr) };
    case "not":
    case "line":
    case "section":
      return { kind: expr.kind, children: [nativeSearchExpr(expr.child)] };
    case "attr":
      return { kind: "attr", key: expr.key, ...(expr.value === null ? {} : { value: expr.value }) };
    default:
      return { kind: expr.kind, value: expr.value };
  }
}

/** 书签转为原生层的扁平对象；缺省字段省略键（exactOptionalPropertyTypes）。 */
function nativeBookmark(item: Bookmark): NativeModule.JsBookmark {
  const title = item.title === null ? {} : { title: item.title };
  switch (item.kind) {
    case "search":
      return { kind: "search", query: item.query, ...title };
    case "heading":
      return { kind: "heading", path: item.path, heading: item.heading, ...title };
    default:
      return { kind: item.kind, path: item.path, ...title };
  }
}

function mapMentions(value: NativeModule.JsMentions): Mentions {
  return parseMentions({
    linked: value.linked.map(mapMention),
    unlinked: value.unlinked.map(mapMention),
  });
}

/**
 * 会话阅读栈的路径迁移；没有任何变化时返回 null，避免无谓的会话重写。
 *
 * @param history 持久化的阅读栈。
 * @param mapPath 与当前文档同口径的路径映射；null 表示条目应移除。
 */
function mapSessionHistory(
  history: SessionHistory,
  mapPath: (path: string) => string | null,
): SessionHistory | null {
  let changed = false;
  const map = (entries: HistoryEntry[]): HistoryEntry[] =>
    entries.flatMap((entry) => {
      const path = mapPath(entry.path);
      if (path === null) {
        changed = true;
        return [];
      }
      if (path !== entry.path) changed = true;
      return [{ ...entry, path }];
    });
  const back = map(history.back);
  const forward = map(history.forward);
  return changed ? { back, forward } : null;
}

/** 全部分栏的文档会话迁移；没有任何变化时返回 null，避免无谓的会话重写。 */
function mapSessionDocuments(
  documents: SessionDocuments,
  mapPath: (path: string) => string | null,
): SessionDocuments | null {
  let changed = false;
  const panes = documents.panes.map((pane) => {
    let currentPath = pane.currentPath;
    if (currentPath !== null) {
      const mapped = mapPath(currentPath);
      if (mapped !== currentPath) {
        currentPath = mapped;
        changed = true;
      }
    }
    const history = mapSessionHistory(pane.history, mapPath);
    if (history !== null) changed = true;
    return { currentPath, history: history ?? pane.history };
  });
  return changed ? { ...documents, panes } : null;
}

/**
 * 创建仅由工作线程使用的同步内核服务，所有命令共用同一库与会话。
 *
 * @param userData 应用数据目录，不能由渲染进程指定。
 * @param onChanged 当前库的索引刷新通知；关闭或切库后丢弃旧回调。
 * @param sessions 只暴露阅读器状态的存储接口，应用窗口和主题不可经此写入。
 * @returns 按消息顺序调用的命令集合；磁盘与内核错误由调用方转发。
 * 返回的字节均为独占副本，供工作线程转移；不得返回原生 Buffer 或复用缓冲区。
 * @throws 原生模块无法加载时抛出加载错误；不创建部分可用的服务。
 */
export function createReaderService(
  userData: string,
  onChanged: (event: VaultEvent) => void,
  sessions: ReaderSessionStore,
) {
  const native = require("@nous/native") as typeof NativeModule;
  let activeVault: object | null = null;

  function openVault(root: string): void {
    const vault = {};
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    native.vaultOpen(root, join(userData, "vaults", hash), (event: unknown) => {
      if (activeVault === vault) {
        try {
          onChanged(parseVaultEvent(event));
        } catch (error) {
          onChanged({ status: "index-error", paths: [], message: String(error) });
        }
      }
    });
    // 打开失败时保留原库及其回调归属。
    activeVault = vault;
  }

  function rememberEntryChange(
    warning: string | null,
    mapPath: (path: string) => string | null,
  ): RenameOutcome {
    try {
      const session = sessions.load();
      // 各分栏的当前文档、阅读栈、视图记忆与最近列表同一口径跟随改名/删除。
      const documents = mapSessionDocuments(session.documents, mapPath);
      const viewModes = mapViewModes(session.viewModes, mapPath);
      const recentFiles = mapPathList(session.recentFiles, mapPath);
      if (documents !== null || viewModes !== null || recentFiles !== null)
        sessions.save({
          ...session,
          documents: documents ?? session.documents,
          viewModes: viewModes ?? session.viewModes,
          recentFiles: recentFiles ?? session.recentFiles,
        });
    } catch (error) {
      warning = [warning, `文件操作已完成，会话更新失败：${String(error)}`]
        .filter(Boolean)
        .join("；");
    }
    onChanged({ status: "changed", paths: [], healthy: false });
    return { warning };
  }

  return {
    vaultOpen(root: string): string {
      const previous = sessions.load();
      // 先确认会话可写，避免内核已切库、界面却因会话写入失败而留在原库。
      // 阅读栈属于旧库，切库即清空。
      sessions.save({
        ...previous,
        vaultRoot: root,
        documents: emptySessionDocuments(),
        viewModes: {},
        recentFiles: [],
      });
      try {
        openVault(root);
      } catch (error) {
        try {
          sessions.save(previous);
        } catch (restoreError) {
          throw new Error(`${String(error)}；恢复上次会话失败：${String(restoreError)}`);
        }
        throw error;
      }
      return root;
    },
    vaultRestore(): VaultRestore | null {
      const stored = sessions.load();
      const root = stored.vaultRoot;
      if (root === null || !isDirectory(root)) return null;
      openVault(root);
      return {
        root,
        documents: stored.documents,
        viewModes: stored.viewModes,
        recentFiles: stored.recentFiles,
      };
    },
    vaultClose(): void {
      native.vaultClose();
      activeVault = null;
    },
    vaultList(): string[] {
      return native.vaultList();
    },
    vaultEntries(): VaultEntry[] {
      return native.vaultEntries().map((entry) => {
        if (entry.kind !== "file" && entry.kind !== "directory") throw new Error("未知条目类型");
        return {
          path: entry.path,
          kind: entry.kind,
          ...(entry.recoveryOnly ? { recoveryOnly: true as const } : {}),
        };
      });
    },
    entryCreate(path: string, kind: VaultEntry["kind"], content?: Uint8Array): RenameOutcome {
      return rememberEntryChange(
        native.entryCreate(path, kind, content === undefined ? null : Buffer.from(content))
          .warning ?? null,
        (current) => current,
      );
    },
    entryTrash(path: string): RenameOutcome {
      return rememberEntryChange(native.entryTrash(path).warning ?? null, (current) =>
        current === path || current.startsWith(`${path}/`) ? null : current,
      );
    },
    entryPath(path: string): string {
      return native.entryPath(path);
    },
    attachmentImport(root: string, from: string, name: string, bytes: Uint8Array) {
      const request = parseAttachmentRequest(root, from, name, bytes);
      if (activeVault === null || sessions.load().vaultRoot !== request.root)
        throw new Error("笔记库已切换，请回到原笔记重新插入附件");
      const result = native.attachmentImport(
        request.from,
        request.name,
        Buffer.from(request.bytes),
      );
      const imported = parseImportedAttachment({
        path: result.path,
        warning: result.warning ?? null,
      });
      onChanged({ status: "changed", paths: [imported.path], healthy: imported.warning === null });
      return imported;
    },
    readerSessionLoad(): ReaderSession {
      return sessions.load();
    },
    readerSessionPatch(patch: Partial<ReaderSession>): void {
      sessions.save({ ...sessions.load(), ...patch });
    },
    fileRead(rel: string): Uint8Array {
      return new Uint8Array(parseFileBytes(native.fileRead(rel)));
    },
    fileSnapshot(rel: string): FileSnapshot {
      const snapshot = native.fileSnapshot(rel);
      return {
        disk: snapshot.disk == null ? null : new Uint8Array(parseFileBytes(snapshot.disk)),
        ...(snapshot.diskError == null ? {} : { diskError: snapshot.diskError }),
        draft:
          snapshot.draft == null
            ? null
            : {
                bytes: new Uint8Array(parseFileBytes(snapshot.draft.bytes)),
                base:
                  snapshot.draft.base == null
                    ? null
                    : new Uint8Array(parseFileBytes(snapshot.draft.base)),
                ...(snapshot.draft.editor == null ? {} : { editor: snapshot.draft.editor }),
              },
      };
    },
    filePreserveDraft(
      rel: string,
      source: Uint8Array,
      expected: Uint8Array | null,
      editor: string,
    ): void {
      const request = parseDraftRequest(rel, source, expected, editor);
      native.filePreserveDraft(
        request.rel,
        Buffer.from(request.source),
        request.expected === null ? null : Buffer.from(request.expected),
        request.editor,
      );
    },
    fileWrite(rel: string, bytes: Uint8Array, expected: Uint8Array | null): WriteResult {
      const result = native.fileWrite(
        rel,
        Buffer.from(bytes),
        expected === null ? null : Buffer.from(expected),
      );
      if (result.status === "conflict") {
        return parseWriteResult({
          status: "conflict",
          disk: result.disk == null ? null : new Uint8Array(parseFileBytes(result.disk)),
        });
      }
      return parseWriteResult({ status: result.status, warning: result.warning ?? null });
    },
    fileWriteCopy(rel: string, bytes: Uint8Array, expected: Uint8Array | null): SavedCopy {
      const copy = native.fileWriteCopy(
        rel,
        Buffer.from(bytes),
        expected === null ? null : Buffer.from(expected),
      );
      return parseSavedCopy({ path: copy.path, warning: copy.warning ?? null });
    },
    linksResolve(from: string, raw: string, kind: LinkKind): LinkTarget {
      const target = native.linksResolve(from, raw, kind);
      return parseLinkTarget({
        status: target.status,
        path: target.path ?? null,
        candidates: target.candidates ?? null,
        anchor: target.anchor ?? null,
      });
    },
    indexLinksTo(path: string): LinkRecord[] {
      return parseLinkRecords(native.indexLinksTo(path).map(mapLink));
    },
    indexLinksFrom(path: string): LinkRecord[] {
      return parseLinkRecords(native.indexLinksFrom(path).map(mapLink));
    },
    indexMentionsTo(path: string): Mentions {
      return mapMentions(native.indexMentionsTo(path));
    },
    mentionsLinkify(
      from: string,
      startByte: number,
      endByte: number,
      expected: string,
      target: string,
    ): RenameOutcome {
      return parseEntryOutcome({
        warning: native.mentionsLinkify(from, startByte, endByte, expected, target).warning ?? null,
      });
    },
    searchQuery(query: SearchQuery): SearchHit[] {
      const request = parseSearchQueryArgument(query);
      return parseSearchHits(
        native.searchQuery({ expr: nativeSearchExpr(request.expr), limit: request.limit }),
      );
    },
    indexHeadings(path: string): HeadingRecord[] {
      return parseHeadingRecords(native.indexHeadings(path));
    },
    indexTags(): TagCount[] {
      return parseTagCounts(native.indexTags());
    },
    indexNoteKeys(): NoteKeys[] {
      return parseNoteKeys(native.indexNoteKeys());
    },
    indexGraph(includeDead: boolean): VaultGraph {
      return parseGraph(native.indexGraph(includeDead));
    },
    bookmarksList(): Bookmark[] {
      return parseBookmarks(
        native.bookmarksList().map((item) => ({
          kind: item.kind,
          path: item.path ?? null,
          heading: item.heading ?? null,
          query: item.query ?? null,
          title: item.title ?? null,
        })),
      );
    },
    bookmarksSet(items: Bookmark[]): void {
      native.bookmarksSet(parseBookmarks(items).map(nativeBookmark));
    },
    entryRename(from: string, to: string): RenameOutcome {
      const result = native.entryRename(from, to);
      return rememberEntryChange(result.warning ?? null, (current) =>
        current === from
          ? to
          : current.startsWith(`${from}/`)
            ? `${to}${current.slice(from.length)}`
            : current,
      );
    },
  };
}

/** 工作线程协议直接使用服务签名，避免参数与返回值各维护一份。 */
export type ReaderService = ReturnType<typeof createReaderService>;
