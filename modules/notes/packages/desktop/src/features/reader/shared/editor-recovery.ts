import type { FileSnapshot } from "./api";

/** 恢复内容只用于重建编辑会话；doc 在编辑器边界继续按 ProseMirror schema 验证。 */
export type EditorRecovery = {
  format: "nous.prosemirror";
  version: 1;
  revision: number;
  doc: unknown;
};

/** 验证恢复格式和版本；未知版本保留在磁盘，不能当普通源码打开后覆盖。 */
export function parseEditorRecovery(value: unknown): EditorRecovery {
  if (typeof value !== "string") throw new Error("编辑恢复数据必须是文本");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("编辑恢复数据损坏，原记录已保留", { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("format" in parsed) ||
    parsed.format !== "nous.prosemirror" ||
    !("version" in parsed) ||
    parsed.version !== 1
  )
    throw new Error("此编辑恢复格式暂不支持，请使用兼容的 Nous 版本；恢复记录已保留");
  if (
    !("revision" in parsed) ||
    typeof parsed.revision !== "number" ||
    !Number.isSafeInteger(parsed.revision) ||
    parsed.revision < 0 ||
    !("doc" in parsed) ||
    typeof parsed.doc !== "object" ||
    parsed.doc === null ||
    !("type" in parsed.doc) ||
    parsed.doc.type !== "doc"
  )
    throw new Error("编辑恢复内容无效；恢复记录已保留");
  return { format: "nous.prosemirror", version: 1, revision: parsed.revision, doc: parsed.doc };
}

/** 校验跨进程恢复写入请求；文件路径和磁盘访问仍由内核约束。 */
export function parseDraftRequest(
  rel: unknown,
  source: unknown,
  expected: unknown,
  editor: unknown,
) {
  if (
    typeof rel !== "string" ||
    rel === "" ||
    !(source instanceof Uint8Array) ||
    (expected !== null && !(expected instanceof Uint8Array)) ||
    typeof editor !== "string"
  )
    throw new Error("编辑恢复请求的路径或字节无效");
  parseEditorRecovery(editor);
  return { rel, source, expected, editor };
}

/** 业务结果保留真实失败原因，避免把 Electron IPC 包装信息直接展示给用户。 */
export type DraftReply = { status: "preserved" } | { status: "failed"; message: string };

/** 验证恢复写入确认；失败或未知返回值抛错，不能误报草稿已保留。 */
export function parseDraftReply(value: unknown): void {
  if (typeof value === "object" && value !== null && "status" in value) {
    if (value.status === "preserved") return;
    if (
      value.status === "failed" &&
      "message" in value &&
      typeof value.message === "string" &&
      value.message.trim() !== ""
    )
      throw new Error(value.message);
  }
  throw new Error("未收到有效的恢复写入确认");
}

/** 验证加载快照的字节与可选恢复字段；恢复版本和 schema 在加载编辑会话前验证。 */
export function parseFileSnapshot(value: unknown): FileSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    !("disk" in value) ||
    (value.disk !== null && !(value.disk instanceof Uint8Array)) ||
    !("draft" in value) ||
    ("diskError" in value && typeof value.diskError !== "string")
  )
    throw new Error("文件快照缺少有效磁盘状态");
  const disk = value.disk;
  const diskError =
    "diskError" in value && typeof value.diskError === "string"
      ? { diskError: value.diskError }
      : {};
  if (value.draft === null) return { disk, ...diskError, draft: null };
  const draft = value.draft;
  if (
    typeof draft !== "object" ||
    !("bytes" in draft) ||
    !(draft.bytes instanceof Uint8Array) ||
    !("base" in draft) ||
    (draft.base !== null && !(draft.base instanceof Uint8Array)) ||
    ("editor" in draft && typeof draft.editor !== "string")
  )
    throw new Error("文件快照缺少有效恢复草稿");
  return {
    disk,
    ...diskError,
    draft: {
      bytes: draft.bytes,
      base: draft.base,
      ...("editor" in draft && typeof draft.editor === "string" ? { editor: draft.editor } : {}),
    },
  };
}
