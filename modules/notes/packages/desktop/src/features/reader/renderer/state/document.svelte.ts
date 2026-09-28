import type { FileSnapshot, ReaderApi, SavedCopy, WriteResult } from "../../shared/api";
import { readFileContent, type FileContent } from "../engine/document/file-content";
import { bytesEqual } from "../engine/document/reload";
import { bytesForSave, commitSuccessfulWrite } from "../engine/document/save";
import type { EditorSnapshot } from "../engine/markdown/source-session";
import {
  MarkdownSnapshotError,
  restoreMarkdownRecovery,
} from "../engine/markdown/session-recovery";

/** 副本已提交；重新获取编辑内容失败时仍必须报告真实路径，不能误报写盘失败。 */
export type CopyCommit = SavedCopy & { refreshError: string | null };

/**
 * 活动文档拥有唯一的保存基准、编辑代次与冲突状态；界面不直接修改这些字段。
 * 编辑器持有实时文本，本对象仅在加载或重载时提供初始内容，避免保存时重建编辑器。
 */
export class ReaderDocument {
  private current = $state<string | null>(null);
  private baseline = $state<Uint8Array | null>(null);
  private loaded = $state.raw<FileContent | null>(null);
  private version = $state(0);
  private edited = $state(false);
  private collision = $state<{ disk: Uint8Array | null; error?: string } | null>(null);
  private failure = $state<string | null>(null);
  private mappingFailure = $state(false);
  private writing = $state(false);
  private editGeneration = $state(0);

  /** @param api 注入原文件、副本与恢复记录的持久化能力；构造时不访问磁盘。 */
  constructor(
    private readonly api: Pick<ReaderApi, "fileWrite" | "fileWriteCopy" | "filePreserveDraft">,
  ) {}

  /** 当前库内路径；空工作区为 null。 */
  get path() {
    return this.current;
  }
  /** 上次成功提交的字节；null 表示原文件不存在。 */
  get originalBytes() {
    return this.baseline;
  }
  /** 编辑器初始内容或只读附件。 */
  get content() {
    return this.loaded;
  }
  /** 每次文档替换递增，供异步请求和编辑器挂载判定归属。 */
  get epoch() {
    return this.version;
  }
  /** 当前编辑是否超前于保存基准。 */
  get dirty() {
    return this.edited;
  }
  /** 当前编辑代次，用于识别对比快照是否已过期；与保存提交使用同一版本。 */
  get editRevision() {
    return this.editGeneration;
  }
  /** 外部修改或删除造成的保存冲突。 */
  get conflict() {
    return this.collision;
  }
  /** 最近一次写入失败原因。 */
  get saveError() {
    return this.failure;
  }
  /** 当前保存需要先修正无法表示为 Markdown 的结构，另存普通副本同样无法绕过。 */
  get needsSourceRepair() {
    return this.mappingFailure;
  }
  /** 是否正在提交原文件。 */
  get saving() {
    return this.writing;
  }
  /** 附件不能进入保存流程。 */
  get canEdit() {
    return this.loaded?.kind === "markdown" || this.loaded?.kind === "text";
  }

  /** 清空文档并使旧异步结果失效；不写磁盘或会话。 */
  clear(): void {
    this.version += 1;
    this.current = null;
    this.baseline = null;
    this.loaded = null;
    this.edited = false;
    this.collision = null;
    this.failure = null;
    this.mappingFailure = false;
  }

  /**
   * 从磁盘与恢复草稿建立完整快照，附件草稿不能覆盖二进制原文件。
   * @param path 库内相对路径。
   * @param snapshot 同一次读取返回的磁盘版本与草稿。
   * @throws 文件和草稿均不存在，或恢复版本、文档格式无效时抛出，保持原文档不变。
   */
  load(path: string, snapshot: FileSnapshot): void {
    let bytes = snapshot.draft?.bytes ?? snapshot.disk;
    if (bytes === null) throw new Error("文件已不存在");
    const baseBytes = snapshot.draft?.base ?? bytes;
    const baseContent = readFileContent(path, baseBytes);
    const editable = baseContent.kind === "markdown" || baseContent.kind === "text";
    // 磁盘变为二进制时仍保留有效文本草稿；旧版本误建的附件草稿不参与编辑。
    if (!editable) bytes = snapshot.disk ?? baseBytes;
    let content = bytes === baseBytes ? baseContent : readFileContent(path, bytes);
    const recovery = snapshot.draft?.editor;
    if (recovery !== undefined) {
      if (content.kind !== "markdown") throw new Error("编辑恢复记录不属于 Markdown，已保留原记录");
      // 验证必须发生在切换文档之前，损坏记录不能让当前编辑被空白表面替换。
      restoreMarkdownRecovery(recovery);
      content = { ...content, recovery };
    }
    this.version += 1;
    this.baseline = editable && snapshot.draft !== null ? snapshot.draft.base : snapshot.disk;
    this.loaded = content;
    this.current = path;
    this.edited = this.canEdit && editable && snapshot.draft !== null;
    this.collision =
      this.edited && (snapshot.diskError !== undefined || !bytesEqual(snapshot.disk, this.baseline))
        ? {
            disk: snapshot.disk,
            ...(snapshot.diskError === undefined ? {} : { error: snapshot.diskError }),
          }
        : null;
    this.mappingFailure = recovery !== undefined;
    this.failure =
      recovery === undefined
        ? null
        : "已从本地恢复上次未能写入 Markdown 的编辑。请调整该处内容后重试保存。";
  }

  /**
   * 应用属于当前文档的外部版本；有未保存编辑时只更新冲突，不替换编辑器。
   * @param disk 当前磁盘字节；null 且无 diskError 时表示删除。调用方须先校验异步请求归属。
   * @param diskError 原路径读取失败原因；保留当前编辑，不能按文件删除清空。
   */
  refresh(disk: Uint8Array | null, diskError?: string): void {
    if (diskError !== undefined) {
      this.collision = { disk, error: diskError };
    } else if (this.edited) {
      this.collision = bytesEqual(disk, this.baseline) ? null : { disk };
    } else if (disk === null) {
      this.clear();
    } else if (this.current !== null && !bytesEqual(disk, this.baseline)) {
      this.version += 1;
      this.baseline = disk;
      this.loaded = readFileContent(this.current, disk);
    }
  }

  /** 记录可编辑文档的一次修改；写盘期间输入同样增加代次。 */
  markDirty(): void {
    if (!this.canEdit) return;
    this.edited = true;
    this.editGeneration += 1;
  }

  /**
   * 视图切换（排版 ⇄ 源码）时以最新文本原地替换加载内容。
   *
   * 保存基准、脏标记与冲突状态全部保持：切换视图不是编辑，也不改变
   * 磁盘契约；代次递增让旧表面的异步结果自然失效。恢复记录（recovery）
   * 属于排版会话，调用方必须先确认 `needsSourceRepair` 为假再切换。
   *
   * @param text 当前活动表面的最新源码文本。
   * @throws 当前内容不是可切换的 Markdown 时抛出。
   */
  replaceSourceText(text: string): void {
    if (this.loaded?.kind !== "markdown") throw new Error("只有 Markdown 文档支持切换视图");
    this.version += 1;
    this.loaded = { kind: "markdown", source: text };
  }

  /**
   * 基于原始版本提交，期间的新输入继续保持未保存。
   * @param snapshot 从当前编辑器取得最新字节；未就绪时允许抛出。
   * @returns 写入结果；异常记录为 saveError，旧文档结果被丢弃，均返回 null。
   */
  async save(snapshot: () => EditorSnapshot): Promise<WriteResult | null> {
    if (this.current === null || !this.canEdit) return null;
    const epoch = this.version;
    const path = this.current;
    const base = this.baseline;
    const generation = this.editGeneration;
    this.writing = true;
    try {
      const bytes = bytesForSave(this.edited, this.baseline ?? new Uint8Array(), snapshot);
      const result = await this.api.fileWrite(this.current, bytes, this.baseline);
      if (epoch !== this.version) return null;
      this.failure = null;
      this.mappingFailure = false;
      if (result.status === "conflict") {
        this.collision = { disk: result.disk };
      } else {
        const commit = commitSuccessfulWrite(bytes, generation, this.editGeneration);
        this.baseline = commit.originalBytes;
        this.edited = commit.dirty;
        this.collision = null;
      }
      return result;
    } catch (error) {
      const failure = await this.preserveSnapshotFailure(error, path, base);
      if (epoch === this.version) {
        this.recordSaveError(failure);
        this.mappingFailure = error instanceof MarkdownSnapshotError;
      }
      return null;
    } finally {
      this.writing = false;
    }
  }

  /**
   * 创建副本并以已提交内容为基准，等待期间的新输入带入副本继续编辑。
   * @param snapshot 当前编辑器保真快照入口。
   * @param beforeApply 提交后切换编辑器前等待输入法等编辑事务完成；默认可立即切换。
   * @returns 已提交路径、索引警告与编辑器刷新错误；刷新失败时保留原编辑。
   * @throws 无活动文本、写入前序列化失败或写入失败时抛出，交由工作区展示错误。
   */
  async copy(
    snapshot: () => EditorSnapshot,
    beforeApply: () => Promise<void> = async () => {},
  ): Promise<CopyCommit> {
    if (this.current === null || !this.canEdit) throw new Error("没有可另存的文本");
    const path = this.current;
    const base = this.baseline;
    const epoch = this.version;
    const generation = this.editGeneration;
    let bytes: Uint8Array;
    try {
      bytes = bytesForSave(this.edited, this.baseline ?? new Uint8Array(), snapshot);
    } catch (error) {
      const failure = await this.preserveSnapshotFailure(error, path, base);
      if (epoch === this.version) this.mappingFailure = error instanceof MarkdownSnapshotError;
      throw failure;
    }
    const copy = await this.api.fileWriteCopy(this.current, bytes, this.baseline);
    let latest: Uint8Array;
    try {
      await beforeApply();
      latest = this.editGeneration === generation ? bytes : snapshot().bytes;
    } catch (error) {
      const failure = await this.preserveSnapshotFailure(error, path, base);
      if (epoch === this.version) this.mappingFailure = error instanceof MarkdownSnapshotError;
      return {
        ...copy,
        refreshError: failure instanceof Error ? failure.message : String(failure),
      };
    }
    this.version += 1;
    this.current = copy.path;
    this.loaded = readFileContent(copy.path, latest);
    this.baseline = bytes;
    this.edited = this.editGeneration !== generation;
    this.collision = null;
    this.failure = null;
    this.mappingFailure = false;
    return { ...copy, refreshError: null };
  }

  /** @param error 写入失败原因；保留编辑内容，供用户重试或另存。 */
  recordSaveError(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error);
  }

  private async preserveSnapshotFailure(
    error: unknown,
    path: string,
    base: Uint8Array | null,
  ): Promise<unknown> {
    if (!(error instanceof MarkdownSnapshotError)) return error;
    try {
      await this.api.filePreserveDraft(path, error.recovery.source, base, error.recovery.editor);
      return new Error(
        "本次尝试保存时的编辑已写入本地恢复记录，重新打开后可继续处理。后续修改需再次保存。",
        { cause: error },
      );
    } catch (cause) {
      return new Error(
        `恢复记录也未能写入：${cause instanceof Error ? cause.message : String(cause)}。请保持窗口打开并重试。`,
        { cause },
      );
    }
  }
}
