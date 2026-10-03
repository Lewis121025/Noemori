import { Fragment } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentImporter,
  type ImportedAttachment,
} from "../../../shared/attachments";
import { mimeFromPath, previewKindFromMime } from "../../preview/media";
import { isWhiteboardPath } from "../../../shared/whiteboard/model";

/** 导入进度与可重试错误；不包含正文或保存状态。 */
export type AttachmentProgress =
  | { status: "importing"; name: string; completed: number; total: number }
  | { status: "failed"; message: string }
  | null;

/** 当前插入点必须属于普通行内内容，源码节点和代码块不接收附件。 */
export function canInsertAttachment(state: EditorState, pos = state.selection.to): boolean {
  const parent = state.doc.resolve(pos).parent;
  return parent.inlineContent && !parent.type.spec.code;
}

function attachmentContent(state: EditorState, imported: ImportedAttachment): Fragment {
  const name = imported.path.split("/").at(-1);
  if (!name) throw new Error("附件缺少文件名");
  const href = `./attachments/${encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  const preview = previewKindFromMime(mimeFromPath(name));
  const node =
    preview !== null
      ? state.schema.node(preview, { src: href, alt: name, kind: "md" })
      : state.schema.text(name, [state.schema.mark("link", { href })]);
  return Fragment.fromArray([node, state.schema.text(" ")]);
}

/**
 * 创建单个编辑会话的附件导入器。插件映射唯一插入点，异步结果只作用于所属视图。
 * 文件顺序导入，重试从失败文件继续；已提交但无法插入的文件保留并报告路径。
 * @param io 捕获文档身份的字节导入能力与状态反馈。
 * @returns 插件、选择文件前的准备、导入及失败重试入口；销毁视图自动取消剩余操作。
 */
export function createAttachmentEditing(io: {
  import: AttachmentImporter;
  progress: (progress: AttachmentProgress) => void;
  report: (message: string) => void;
  /** 导入或失败处理完成后，允许工作区重试被推迟的外部刷新。 */
  settled?: () => void;
}) {
  const key = new PluginKey<number | null>("attachment-insertion");
  let live = true;
  let busy = false;
  let failed: File[] = [];
  const compositionWaiters = new Set<() => void>();
  const idleWaiters = new Set<(ready: boolean) => void>();

  function clear(view: EditorView): void {
    failed = [];
    if (live) {
      view.dispatch(view.state.tr.setMeta(key, "clear").setMeta("addToHistory", false));
      io.progress(null);
      if (!busy) io.settled?.();
    }
  }

  function prepare(view: EditorView, pos = view.state.selection.to): boolean {
    if (!live || !view.editable) return false;
    if (busy || failed.length > 0) {
      io.report("请先完成或关闭当前附件导入，再插入其他附件。");
      return false;
    }
    if (view.composing || !canInsertAttachment(view.state, pos)) {
      io.report("请完成输入法组词，并将光标放在正文中再插入附件。");
      return false;
    }
    // 异步导入不能在返回时删除一段可能已经被用户改动的选区；插入于选区末尾。
    view.dispatch(view.state.tr.setMeta(key, pos).setMeta("addToHistory", false));
    return true;
  }

  async function waitForComposition(view: EditorView): Promise<void> {
    while (view.composing && live) {
      await new Promise<void>((resolve) => {
        const done = () => {
          view.dom.removeEventListener("compositionend", ended);
          compositionWaiters.delete(done);
          resolve();
        };
        // ProseMirror 在原生事件的后续处理里结束 composition，下一任务再提交插入事务。
        const ended = () => setTimeout(done, 0);
        compositionWaiters.add(done);
        view.dom.addEventListener("compositionend", ended, { once: true });
      });
    }
  }

  async function insertFiles(view: EditorView, files: File[]): Promise<void> {
    if (busy || !live || !view.editable) return;
    if (files.length === 0) {
      clear(view);
      return;
    }
    if (key.getState(view.state) == null) {
      io.report("插入位置已被删除，附件未导入；请重新选择正文位置。");
      clear(view);
      return;
    }
    busy = true;
    failed = [];
    try {
      for (const [index, file] of files.entries()) {
        io.progress({
          status: "importing",
          name: file.name,
          completed: index,
          total: files.length,
        });
        let imported: ImportedAttachment | null = null;
        try {
          if (file.size > MAX_ATTACHMENT_BYTES)
            throw new Error("附件超过 64 MiB，请缩小文件后重试");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!live) return;
          if (!view.editable || key.getState(view.state) == null) {
            io.report(
              "文档已进入阅读状态或插入位置已变化，附件未导入；请返回编辑并重新选择正文位置。",
            );
            clear(view);
            return;
          }
          imported = await io.import(file.name, bytes);
          await waitForComposition(view);
          const pos = live ? key.getState(view.state) : null;
          if (!view.editable || pos == null || !canInsertAttachment(view.state, pos)) {
            io.report(
              `附件已导入 ${imported.path}，原文档或插入位置已变化，尚未插入引用。可从文件栏查看，或通过链接插入；无需重复导入。${imported.warning ?? ""}`,
            );
            clear(view);
            return;
          }
          const tr = closeHistory(view.state.tr);
          if (isWhiteboardPath(imported.path)) {
            // 白板是块级引用；段落中间插入时由 ProseMirror 合法拆分正文，不能塞进句中。
            tr.replaceRangeWith(
              pos,
              pos,
              view.state.schema.node("note_embed", {
                target: imported.path,
                anchor: null,
                alias: null,
              }),
            );
          } else tr.insert(pos, attachmentContent(view.state, imported));
          if (view.hasFocus() && view.state.selection.empty && view.state.selection.from === pos)
            tr.scrollIntoView();
          view.dispatch(tr);
          view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
          if (imported.warning) io.report(`附件已导入 ${imported.path}。${imported.warning}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (imported !== null) {
            io.report(
              `附件已导入 ${imported.path}，引用插入失败：${reason}。请从文件栏查看，无需重复导入。`,
            );
            clear(view);
          } else if (live) {
            failed = files.slice(index);
            io.progress({
              status: "failed",
              message: `“${file.name}”未导入：${reason}。已插入的附件保留，可重试剩余文件。`,
            });
          } else io.report(`“${file.name}”未导入：${reason}。请回到原笔记重新插入。`);
          return;
        }
      }
      clear(view);
    } finally {
      busy = false;
      for (const resolve of idleWaiters) resolve(live && failed.length === 0);
      idleWaiters.clear();
      if (live && failed.length === 0) io.settled?.();
    }
  }

  const plugin = new Plugin<number | null>({
    key,
    state: {
      init: () => null,
      apply(tr, pos) {
        const action: unknown = tr.getMeta(key);
        if (typeof action === "number") return action;
        if (action === "clear" || pos === null) return null;
        const mapped = tr.mapping.mapResult(pos, 1);
        return mapped.deletedAcross ? null : mapped.pos;
      },
    },
    props: {
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        if (prepare(view)) void insertFiles(view, files);
        return true;
      },
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        if (pos !== undefined && prepare(view, pos)) void insertFiles(view, files);
        return true;
      },
    },
    view: () => ({
      destroy() {
        live = false;
        failed = [];
        for (const done of compositionWaiters) done();
        for (const resolve of idleWaiters) resolve(false);
        idleWaiters.clear();
      },
    }),
  });
  return {
    plugin,
    prepare,
    insertFiles,
    dismiss: clear,
    retry: (view: EditorView) => insertFiles(view, failed),
    /** 离开文档前等待整批插入；失败保留 File 供用户重试或明确关闭错误。 */
    settle: (): Promise<boolean> =>
      busy
        ? new Promise((resolve) => idleWaiters.add(resolve))
        : Promise.resolve(live && failed.length === 0),
  };
}
