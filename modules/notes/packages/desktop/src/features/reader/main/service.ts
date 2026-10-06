/** 阅读器协议适配：业务和持久化由 Rust 运行时执行。 */
import type * as NativeModule from "@noemori/vault-node";
import type { ExportNativeAction, ExportRetainAction } from "./export/native";
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
  SearchPage,
  SearchMatchesPage,
  SearchRequest,
  TagCount,
  VaultRestore,
  VaultOpenSnapshot,
  WriteResult,
  VaultEntry,
} from "../shared/api";
import {
  parseEntryBatchRequest,
  parseEntryBatchResult,
  type EntryBatchRequest,
} from "../shared/entry-batch";
import type { FileTreeState } from "../shared/file-browser";
import { parseAttachmentRequest, parseImportedAttachment } from "../shared/attachments";
import { parseDraftRequest } from "../shared/editor-recovery";
import { parseReaderSession, type ReaderSession } from "../shared/session";
import {
  parseBookmarks,
  parseEntryOutcome,
  parseFileBytes,
  parseHeadingRecords,
  parseLinkRecords,
  parseLinkTarget,
  parseMentions,
  parseNoteKeys,
  parseSearchPage,
  parseSemanticStatus,
  parseSearchId,
  parseSearchCursor,
  parseSearchMatchesCursor,
  parseSearchMatchesPage,
  parseSearchRequestArgument,
  parseTagCounts,
  parseWriteResult,
  parseSavedCopy,
  parseVaultEntries,
  parseVaultOpen,
  parseVaultRestore,
} from "../shared/reader-protocol";

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
function nativeSearchRequest(request: SearchRequest): NativeModule.JsSearchQuery {
  return "kind" in request
    ? {
        kind: "hybrid",
        text: request.text,
        filter: nativeSearchExpr(request.filter),
        limit: request.limit,
      }
    : { expr: nativeSearchExpr(request.expr), limit: request.limit };
}

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
 * 适配原生 Promise 与现有阅读器 DTO；不执行文件 I/O 或业务编排。
 * @param native 当前应用的 Rust 运行时句柄。
 * @returns 阅读器命令；原生失败和非法响应保持为拒绝结果。
 */
export function createReaderService(
  native: NativeModule.NativeRuntime,
  createControl: () => NativeModule.NativeControl,
) {
  return {
    exportRecover: () => native.exportRecover(),
    exportPrepare: (
      root: string,
      id: string,
      paths: string[] | null,
      hidden: boolean,
      control: NativeModule.NativeControl,
    ) => native.exportPrepare(root, id, paths, hidden, control),
    exportAction: (
      id: string,
      action: ExportNativeAction | ExportRetainAction,
      bytes?: Uint8Array,
    ) => native.exportAction(id, action, bytes === undefined ? null : Buffer.from(bytes)),
    async vaultOpen(
      root: string,
      control: NativeModule.NativeControl = createControl(),
    ): Promise<VaultOpenSnapshot | null> {
      return parseVaultOpen(await native.vaultOpen(root, control));
    },
    async vaultCreate(
      root: string,
      control: NativeModule.NativeControl = createControl(),
    ): Promise<VaultOpenSnapshot | null> {
      return parseVaultOpen(await native.vaultCreate(root, control));
    },
    async vaultRestore(
      control: NativeModule.NativeControl = createControl(),
    ): Promise<VaultRestore | null> {
      return parseVaultRestore(await native.vaultRestore(control));
    },
    vaultClose(): Promise<void> {
      return native.vaultClose();
    },
    async vaultList(): Promise<string[]> {
      return await native.vaultList();
    },
    async vaultEntries(): Promise<VaultEntry[]> {
      return parseVaultEntries(await native.vaultEntries());
    },
    async entryCreate(
      path: string,
      kind: VaultEntry["kind"],
      content?: Uint8Array,
    ): Promise<RenameOutcome> {
      const result = await native.entryCreate(
        path,
        kind,
        content === undefined ? null : Buffer.from(content),
      );
      return parseEntryOutcome({ warning: result.warning ?? null });
    },
    async entryTrash(path: string): Promise<RenameOutcome> {
      const result = await native.entryTrash(path);
      return parseEntryOutcome({ warning: result.warning ?? null });
    },
    async entryBatch(
      value: EntryBatchRequest,
      control: NativeModule.NativeControl = createControl(),
    ) {
      return parseEntryBatchResult(await native.entryBatch(parseEntryBatchRequest(value), control));
    },
    async entryPath(path: string): Promise<string> {
      return await native.entryPath(path);
    },
    async attachmentImport(root: string, from: string, name: string, bytes: Uint8Array) {
      const request = parseAttachmentRequest(root, from, name, bytes);
      const result = await native.attachmentImport(
        request.root,
        request.from,
        request.name,
        Buffer.from(request.bytes),
      );
      return parseImportedAttachment({ path: result.path, warning: result.warning ?? null });
    },
    async readerSessionLoad(): Promise<ReaderSession> {
      const session = await native.sessionLoad();
      if (typeof session !== "object" || session === null || !("reader" in session))
        throw new Error("内核会话响应无效");
      return parseReaderSession(session.reader);
    },
    readerSessionPatch(patch: Partial<ReaderSession>): Promise<void> {
      return native.readerSessionPatch(patch);
    },
    readerFileTreeSave(root: string, state: FileTreeState): Promise<void> {
      return native.readerFileTreeSave(root, state);
    },
    async fileRead(rel: string): Promise<Uint8Array> {
      return new Uint8Array(parseFileBytes(await native.fileRead(rel)));
    },
    async fileSnapshot(rel: string): Promise<FileSnapshot> {
      const snapshot = await native.fileSnapshot(rel);
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
    async filePreserveDraft(
      rel: string,
      source: Uint8Array,
      expected: Uint8Array | null,
      editor: string,
    ): Promise<void> {
      const request = parseDraftRequest(rel, source, expected, editor);
      await native.filePreserveDraft(
        request.rel,
        Buffer.from(request.source),
        request.expected === null ? null : Buffer.from(request.expected),
        request.editor,
      );
    },
    async fileWrite(
      rel: string,
      bytes: Uint8Array,
      expected: Uint8Array | null,
    ): Promise<WriteResult> {
      const result = await native.fileWrite(
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
    async fileWriteCopy(
      rel: string,
      bytes: Uint8Array,
      expected: Uint8Array | null,
    ): Promise<SavedCopy> {
      const copy = await native.fileWriteCopy(
        rel,
        Buffer.from(bytes),
        expected === null ? null : Buffer.from(expected),
      );
      return parseSavedCopy({ path: copy.path, warning: copy.warning ?? null });
    },
    async linksResolve(from: string, raw: string, kind: LinkKind): Promise<LinkTarget> {
      const target = await native.linksResolve(from, raw, kind);
      return parseLinkTarget({
        status: target.status,
        path: target.path ?? null,
        candidates: target.candidates ?? null,
        anchor: target.anchor ?? null,
      });
    },
    async indexLinksTo(path: string): Promise<LinkRecord[]> {
      return parseLinkRecords((await native.indexLinksTo(path)).map(mapLink));
    },
    async indexLinksFrom(path: string): Promise<LinkRecord[]> {
      return parseLinkRecords((await native.indexLinksFrom(path)).map(mapLink));
    },
    async indexMentionsTo(path: string): Promise<Mentions> {
      return mapMentions(await native.indexMentionsTo(path));
    },
    async mentionsLinkify(
      from: string,
      startByte: number,
      endByte: number,
      expected: string,
      target: string,
    ): Promise<RenameOutcome> {
      return parseEntryOutcome({
        warning:
          (await native.mentionsLinkify(from, startByte, endByte, expected, target)).warning ??
          null,
      });
    },
    async searchQuery(
      query: SearchRequest,
      id: string,
      cursor: string | null,
    ): Promise<SearchPage> {
      const request = parseSearchRequestArgument(query);
      return parseSearchPage(
        await native.searchQuery(
          nativeSearchRequest(request),
          parseSearchId(id),
          parseSearchCursor(cursor),
        ),
      );
    },
    searchModelCancel(id: string): void {
      native.searchModelCancel(parseSearchId(id));
    },
    searchModelBegin(id: string): void {
      native.searchModelBegin(parseSearchId(id));
    },
    async searchModelInstall(source: string | null, id: string) {
      return parseSemanticStatus(await native.searchModelInstall(source, parseSearchId(id)));
    },
    searchCancel(id: string): void {
      native.searchCancel(parseSearchId(id));
    },
    async searchMatches(
      query: SearchRequest,
      id: string,
      cursor: string,
    ): Promise<SearchMatchesPage> {
      const request = parseSearchRequestArgument(query);
      return parseSearchMatchesPage(
        await native.searchMatches(
          nativeSearchRequest(request),
          parseSearchId(id),
          parseSearchMatchesCursor(cursor),
        ),
      );
    },
    async indexHeadings(path: string): Promise<HeadingRecord[]> {
      return parseHeadingRecords(await native.indexHeadings(path));
    },
    async indexTags(): Promise<TagCount[]> {
      return parseTagCounts(await native.indexTags());
    },
    async indexNoteKeys(): Promise<NoteKeys[]> {
      return parseNoteKeys(await native.indexNoteKeys());
    },
    async bookmarksList(): Promise<Bookmark[]> {
      return parseBookmarks(
        (await native.bookmarksList()).map((item) => ({
          kind: item.kind,
          path: item.path ?? null,
          heading: item.heading ?? null,
          query: item.query ?? null,
          title: item.title ?? null,
        })),
      );
    },
    async bookmarksSet(items: Bookmark[]): Promise<void> {
      await native.bookmarksSet(parseBookmarks(items).map(nativeBookmark));
    },
    async entryRename(from: string, to: string): Promise<RenameOutcome> {
      const result = await native.entryRename(from, to);
      return parseEntryOutcome({ warning: result.warning ?? null });
    },
  };
}

/** 阅读器命令由适配器签名推导，避免重复维护 IPC 参数表。 */
export type ReaderService = ReturnType<typeof createReaderService>;
