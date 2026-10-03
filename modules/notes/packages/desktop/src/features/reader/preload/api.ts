import { ipcRenderer } from "electron";
import type { ReaderApi, VaultEvent } from "../shared/api";
import { parseVaultEvent } from "../shared/api";
import { parseVaultOpenProgress, type VaultOpenProgress } from "../shared/vault-opening";
import { parseEntryBatchProgress, parseEntryBatchResult } from "../shared/entry-batch";
import { parseAttachmentReply } from "../shared/attachments";
import { parseFileSnapshot, parseDraftReply } from "../shared/editor-recovery";
import {
  parseBookmarks,
  parseGraph,
  parseEmptyReply,
  parseEntryOutcome,
  parseFileBytes,
  parseHeadingRecords,
  parseLinkRecords,
  parseLinkTarget,
  parseMentions,
  parseNoteKeys,
  parsePaneLayoutMessage,
  parseSavedCopy,
  parseSearchPage,
  parseSemanticStatus,
  parseSearchMatchesPage,
  parseTagCounts,
  parseVaultEntries,
  parseVaultList,
  parseVaultRestore,
  parseVaultOpen,
  parseWriteResult,
} from "../shared/reader-protocol";

/** 创建阅读器受限桥接；只开放已知命令与订阅，错误由对应 Promise 返回。 */
export function createReaderApi(): ReaderApi {
  let batch: { id: string; root: string } | null = null;
  let opening: string | null = null;
  async function open<T>(
    channel: string,
    parse: (value: unknown) => T,
    onProgress?: (progress: VaultOpenProgress) => void,
  ): Promise<T> {
    if (opening !== null) throw new Error("已有资料库正在打开");
    const id = crypto.randomUUID();
    opening = id;
    const listener = (_event: Electron.IpcRendererEvent, eventId: unknown, value: unknown) => {
      if (eventId === id && opening === id) onProgress?.(parseVaultOpenProgress(value));
    };
    ipcRenderer.on("reader.vault.progress", listener);
    try {
      return parse(await ipcRenderer.invoke(channel, id));
    } finally {
      ipcRenderer.removeListener("reader.vault.progress", listener);
      opening = null;
    }
  }
  return {
    openExternal: async (url) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.links.openExternal", url)),
    vaultOpen: (progress) => open("reader.vault.open", parseVaultOpen, progress),
    vaultCreateDefault: (progress) => open("reader.vault.createDefault", parseVaultOpen, progress),
    vaultRestore: (progress) => open("reader.vault.restore", parseVaultRestore, progress),
    vaultOpenCancel: async () => {
      if (opening === null) return false;
      const result: unknown = await ipcRenderer.invoke("reader.vault.cancel", opening);
      if (typeof result !== "boolean") throw new Error("取消打开响应无效");
      return result;
    },
    sessionSetDocuments: async (documents) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.session.setDocuments", documents)),
    sessionSetViewModes: async (modes) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.session.setViewModes", modes)),
    sessionSetRecentFiles: async (paths) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.session.setRecentFiles", paths)),
    sessionSetFileTree: async (root, state) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.session.setFileTree", root, state)),
    sessionGetPanes: async () =>
      parsePaneLayoutMessage(await ipcRenderer.invoke("reader.session.getPanes")),
    sessionSetPanes: async (panes) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.session.setPanes", panes)),
    vaultClose: async () => parseEmptyReply(await ipcRenderer.invoke("reader.vault.close")),
    vaultList: async () => parseVaultList(await ipcRenderer.invoke("reader.vault.list")),
    vaultEntries: async () => parseVaultEntries(await ipcRenderer.invoke("reader.vault.entries")),
    entryCreate: async (path, kind, content) =>
      parseEntryOutcome(
        await ipcRenderer.invoke("reader.entry.create", path, kind, content ?? null),
      ),
    entryTrash: async (path) =>
      parseEntryOutcome(await ipcRenderer.invoke("reader.entry.trash", path)),
    entryBatch: async (request, onProgress) => {
      if (batch !== null) throw new Error("正在处理批量操作，请等待当前批次结束");
      const id = crypto.randomUUID();
      batch = { id, root: request.root };
      let progressWarning: string | null = null;
      const listener = (
        _event: Electron.IpcRendererEvent,
        eventId: unknown,
        value: unknown,
      ): void => {
        if (eventId !== id || batch?.id !== id || onProgress === undefined) return;
        try {
          onProgress(parseEntryBatchProgress(value));
        } catch (error) {
          progressWarning = `进度通知异常：${error instanceof Error ? error.message : String(error)}`;
        }
      };
      ipcRenderer.on("reader.entry.batch.progress", listener);
      try {
        const result = parseEntryBatchResult(
          await ipcRenderer.invoke("reader.entry.batch", request, id),
        );
        if (progressWarning !== null)
          result.warning = [result.warning, progressWarning].filter(Boolean).join("；");
        return result;
      } finally {
        ipcRenderer.removeListener("reader.entry.batch.progress", listener);
        batch = null;
      }
    },
    entryBatchStop: async (root) => {
      if (batch?.root === root)
        parseEmptyReply(await ipcRenderer.invoke("reader.entry.batch.stop", root, batch.id));
    },
    entryReveal: async (path) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.entry.reveal", path)),
    attachmentImport: async (root, from, name, bytes) =>
      parseAttachmentReply(
        await ipcRenderer.invoke("reader.attachment.import", root, from, name, bytes),
      ),
    fileRead: async (rel) => parseFileBytes(await ipcRenderer.invoke("reader.file.read", rel)),
    fileSnapshot: async (rel) =>
      parseFileSnapshot(await ipcRenderer.invoke("reader.file.snapshot", rel)),
    filePreserveDraft: async (rel, source, expected, editor) =>
      parseDraftReply(
        await ipcRenderer.invoke("reader.file.preserveDraft", rel, source, expected, editor),
      ),
    fileWrite: async (rel, bytes, expected) =>
      parseWriteResult(await ipcRenderer.invoke("reader.file.write", rel, bytes, expected)),
    fileWriteCopy: async (rel, bytes, expected) =>
      parseSavedCopy(await ipcRenderer.invoke("reader.file.writeCopy", rel, bytes, expected)),
    linksResolve: async (from, raw, kind) =>
      parseLinkTarget(await ipcRenderer.invoke("reader.links.resolve", from, raw, kind)),
    indexLinksTo: async (path) =>
      parseLinkRecords(await ipcRenderer.invoke("reader.index.linksTo", path)),
    indexMentionsTo: async (path) =>
      parseMentions(await ipcRenderer.invoke("reader.index.mentionsTo", path)),
    mentionsLinkify: async (from, startByte, endByte, expected, target) =>
      parseEntryOutcome(
        await ipcRenderer.invoke(
          "reader.index.linkifyMention",
          from,
          startByte,
          endByte,
          expected,
          target,
        ),
      ),
    indexLinksFrom: async (path) =>
      parseLinkRecords(await ipcRenderer.invoke("reader.index.linksFrom", path)),
    searchQuery: async (query, id, cursor) =>
      parseSearchPage(await ipcRenderer.invoke("reader.search.query", query, id, cursor)),
    searchModelCancel: async (id) => ipcRenderer.invoke("reader.search.modelCancel", id),
    searchModelInstall: async (mode, id) => {
      const result: unknown = await ipcRenderer.invoke("reader.search.modelInstall", mode, id);
      return result === null ? null : parseSemanticStatus(result);
    },
    searchCancel: async (id) => ipcRenderer.invoke("reader.search.cancel", id),
    searchMatches: async (query, id, cursor) =>
      parseSearchMatchesPage(await ipcRenderer.invoke("reader.search.matches", query, id, cursor)),
    indexHeadings: async (path) =>
      parseHeadingRecords(await ipcRenderer.invoke("reader.index.headings", path)),
    indexTags: async () => parseTagCounts(await ipcRenderer.invoke("reader.index.tags")),
    indexNoteKeys: async () => parseNoteKeys(await ipcRenderer.invoke("reader.index.noteKeys")),
    indexGraph: async (includeDead) =>
      parseGraph(await ipcRenderer.invoke("reader.index.graph", includeDead)),
    bookmarksList: async () => parseBookmarks(await ipcRenderer.invoke("reader.bookmarks.list")),
    bookmarksSet: async (items) =>
      parseEmptyReply(await ipcRenderer.invoke("reader.bookmarks.set", items)),
    entryRename: async (from, to) =>
      parseEntryOutcome(await ipcRenderer.invoke("reader.entry.rename", from, to)),
    subscribeVaultChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        let event: VaultEvent;
        try {
          event = parseVaultEvent(value);
        } catch (error) {
          event = {
            status: "index-error",
            paths: [],
            message: `无法识别库变更通知，请重新打开笔记库刷新：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        callback(event);
      };
      ipcRenderer.on("reader.vault.changed", listener);
      return () => {
        ipcRenderer.removeListener("reader.vault.changed", listener);
      };
    },
  };
}
