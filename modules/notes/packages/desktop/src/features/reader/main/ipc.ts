import type { NativeControl } from "@noemori/vault-node";
import { ipcMain, shell, dialog, type BrowserWindow } from "electron";
import { externalUrl } from "../shared/link-target";
import type { PaneLayout } from "../shared/api";
import { parseAttachmentRequest, type AttachmentReply } from "../shared/attachments";
import { parseDraftRequest, type DraftReply } from "../shared/editor-recovery";
import { parseRecentFiles, parseViewModes } from "../shared/session";
import { parseFileTreeMessage } from "../shared/file-browser";
import { registerEntryBatchIpc } from "./entry-batch-ipc";
import { registerVaultOpenIpc } from "./vault-open-ipc";
import { registerExportIpc } from "./export/ipc";
import type { ReaderService } from "./service";
import {
  parseBookmarks,
  parseByteArgument,
  parseEntryKind,
  parseLinkKindArgument,
  parseLinkText,
  parseOptionalBytes,
  parsePaneLayoutMessage,
  parsePathArgument,
  parseSessionDocumentsMessage,
  parseSearchRequestArgument,
  parseSearchId,
  parseSearchCursor,
  parseSearchMatchesCursor,
  parseWriteRequest,
} from "../shared/reader-protocol";

/** 主进程仅能调用阅读器命令，不暴露外壳会话或任意线程消息。 */
export type ReaderClient = {
  createControl(): NativeControl;
  call<C extends keyof ReaderService>(
    command: C,
    ...args: Parameters<ReaderService[C]>
  ): Promise<Awaited<ReturnType<ReaderService[C]>>>;
};

/**
 * 注册阅读器 IPC，文件操作与持久化均在 Rust 后台任务中执行。
 * @param getWindow 目录选择框的父窗口。
 * @param core 注入的阅读器命令客户端。
 * @throws IPC 重复注册或单次命令失败时由 Electron 传播错误。
 */
export function registerReaderIpc(getWindow: () => BrowserWindow | null, core: ReaderClient): void {
  registerExportIpc(getWindow, {
    createControl: () => core.createControl(),
    recover: () => core.call("exportRecover"),
    prepare: (root, id, paths, hidden, control) =>
      core.call("exportPrepare", root, id, paths, hidden, control),
    action: (id, action, bytes) => core.call("exportAction", id, action, bytes),
  });
  ipcMain.handle("reader.links.openExternal", (_event, url: unknown) =>
    shell.openExternal(externalUrl(url)),
  );
  registerVaultOpenIpc(getWindow, core);

  ipcMain.handle("reader.session.setDocuments", (_event, documents: unknown) =>
    core.call("readerSessionPatch", { documents: parseSessionDocumentsMessage(documents) }),
  );

  ipcMain.handle("reader.session.setViewModes", (_event, modes: unknown) =>
    core.call("readerSessionPatch", { viewModes: parseViewModes(modes) }),
  );

  ipcMain.handle("reader.session.setRecentFiles", (_event, paths: unknown) =>
    core.call("readerSessionPatch", { recentFiles: parseRecentFiles(paths) }),
  );
  ipcMain.handle("reader.session.setFileTree", (_event, root: unknown, state: unknown) =>
    core.call("readerFileTreeSave", parsePathArgument(root), parseFileTreeMessage(state)),
  );

  ipcMain.handle("reader.session.getPanes", async (): Promise<PaneLayout> => {
    const session = await core.call("readerSessionLoad");
    return {
      filesCollapsed: session.filesCollapsed,
      leftWidth: session.leftWidth,
      ...(session.space === undefined ? {} : { space: session.space }),
      ...(session.mode === undefined ? {} : { mode: session.mode }),
    };
  });

  ipcMain.handle("reader.session.setPanes", (_event, panes: unknown) => {
    const parsed = parsePaneLayoutMessage(panes);
    return core.call("readerSessionPatch", parsed);
  });

  ipcMain.handle("reader.vault.close", () => core.call("vaultClose"));
  ipcMain.handle("reader.vault.list", () => core.call("vaultList"));
  ipcMain.handle("reader.vault.entries", () => core.call("vaultEntries"));
  ipcMain.handle("reader.entry.create", (_event, path: unknown, kind: unknown, content: unknown) =>
    core.call(
      "entryCreate",
      parsePathArgument(path),
      parseEntryKind(kind),
      parseOptionalBytes(content),
    ),
  );
  ipcMain.handle("reader.entry.trash", (_event, path: unknown) =>
    core.call("entryTrash", parsePathArgument(path)),
  );
  registerEntryBatchIpc(core);
  ipcMain.handle(
    "reader.attachment.import",
    async (
      _event,
      root: unknown,
      from: unknown,
      name: unknown,
      bytes: unknown,
    ): Promise<AttachmentReply> => {
      try {
        const request = parseAttachmentRequest(root, from, name, bytes);
        const attachment = await core.call(
          "attachmentImport",
          request.root,
          request.from,
          request.name,
          request.bytes,
        );
        return { status: "imported", attachment };
      } catch (error) {
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  ipcMain.handle("reader.entry.reveal", async (_event, path: unknown) => {
    shell.showItemInFolder(await core.call("entryPath", parsePathArgument(path)));
  });
  ipcMain.handle("reader.file.read", (_event, rel: unknown) =>
    core.call("fileRead", parsePathArgument(rel)),
  );
  ipcMain.handle("reader.file.snapshot", (_event, rel: unknown) =>
    core.call("fileSnapshot", parsePathArgument(rel)),
  );
  ipcMain.handle(
    "reader.file.preserveDraft",
    async (
      _event,
      rel: unknown,
      source: unknown,
      expected: unknown,
      editor: unknown,
    ): Promise<DraftReply> => {
      try {
        const request = parseDraftRequest(rel, source, expected, editor);
        await core.call(
          "filePreserveDraft",
          request.rel,
          request.source,
          request.expected,
          request.editor,
        );
        return { status: "preserved" };
      } catch (error) {
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  ipcMain.handle("reader.file.write", (_event, rel: unknown, bytes: unknown, expected: unknown) => {
    const request = parseWriteRequest(rel, bytes, expected);
    return core.call("fileWrite", request.rel, request.bytes, request.expected);
  });
  ipcMain.handle(
    "reader.file.writeCopy",
    (_event, rel: unknown, bytes: unknown, expected: unknown) => {
      const request = parseWriteRequest(rel, bytes, expected);
      return core.call("fileWriteCopy", request.rel, request.bytes, request.expected);
    },
  );
  ipcMain.handle("reader.links.resolve", (_event, from: unknown, raw: unknown, kind: unknown) =>
    core.call(
      "linksResolve",
      parsePathArgument(from),
      parseLinkText(raw),
      parseLinkKindArgument(kind),
    ),
  );
  ipcMain.handle("reader.index.linksTo", (_event, path: unknown) =>
    core.call("indexLinksTo", parsePathArgument(path)),
  );
  ipcMain.handle("reader.index.linksFrom", (_event, path: unknown) =>
    core.call("indexLinksFrom", parsePathArgument(path)),
  );
  ipcMain.handle("reader.index.mentionsTo", (_event, path: unknown) =>
    core.call("indexMentionsTo", parsePathArgument(path)),
  );
  ipcMain.handle(
    "reader.index.linkifyMention",
    (
      _event,
      from: unknown,
      startByte: unknown,
      endByte: unknown,
      expected: unknown,
      target: unknown,
    ) =>
      core.call(
        "mentionsLinkify",
        parsePathArgument(from),
        parseByteArgument(startByte),
        parseByteArgument(endByte),
        parseLinkText(expected),
        parsePathArgument(target),
      ),
  );
  ipcMain.handle("reader.search.query", (_event, query: unknown, id: unknown, cursor: unknown) =>
    core.call(
      "searchQuery",
      parseSearchRequestArgument(query),
      parseSearchId(id),
      parseSearchCursor(cursor),
    ),
  );
  ipcMain.handle("reader.search.modelInstall", async (_event, mode: unknown, id: unknown) => {
    const requestId = parseSearchId(id);
    if (mode !== "download" && mode !== "import") throw new Error("模型安装方式无效");
    await core.call("searchModelBegin", requestId);
    let source: string | null = null;
    if (mode === "import") {
      const options = { title: "选择 Harrier 模型目录", properties: ["openDirectory" as const] };
      const window = getWindow();
      const chosen = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (chosen.canceled || !chosen.filePaths[0]) {
        await core.call("searchModelCancel", requestId);
        return null;
      }
      source = chosen.filePaths[0];
    }
    return core.call("searchModelInstall", source, requestId);
  });
  ipcMain.handle("reader.search.modelCancel", (_event, id: unknown) =>
    core.call("searchModelCancel", parseSearchId(id)),
  );
  ipcMain.handle("reader.search.cancel", (_event, id: unknown) =>
    core.call("searchCancel", parseSearchId(id)),
  );
  ipcMain.handle("reader.search.matches", (_event, query: unknown, id: unknown, cursor: unknown) =>
    core.call(
      "searchMatches",
      parseSearchRequestArgument(query),
      parseSearchId(id),
      parseSearchMatchesCursor(cursor),
    ),
  );
  ipcMain.handle("reader.index.headings", (_event, path: unknown) =>
    core.call("indexHeadings", parsePathArgument(path)),
  );
  ipcMain.handle("reader.index.tags", () => core.call("indexTags"));
  ipcMain.handle("reader.index.noteKeys", () => core.call("indexNoteKeys"));
  ipcMain.handle("reader.index.graph", (_event, includeDead: unknown) => {
    if (typeof includeDead !== "boolean") throw new Error("图谱请求无效");
    return core.call("indexGraph", includeDead);
  });
  ipcMain.handle("reader.bookmarks.list", () => core.call("bookmarksList"));
  ipcMain.handle("reader.bookmarks.set", (_event, items: unknown) =>
    core.call("bookmarksSet", parseBookmarks(items)),
  );
  ipcMain.handle("reader.entry.rename", (_event, from: unknown, to: unknown) =>
    core.call("entryRename", parsePathArgument(from), parsePathArgument(to)),
  );
}
