import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  attachmentFilename,
  attachmentId,
  parseAttachments,
  parseAttachmentUploads,
  type AgentAttachment,
  type AttachmentImage,
  type AttachmentPreview,
  type AttachmentUpload,
} from "../shared/attachments";
import { attachmentImage } from "./attachment-images";
import type { LibraryEntriesDrag } from "../../reader/shared/file-drag";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 按文件句柄读取有界快照，文件增长或非普通文件不会绕过选择时的大小限制。 */
async function boundedFile(path: string, limit = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit)
      throw new Error("附件必须是普通文件且不能超过 25 MiB");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("读取时附件内容发生变化，请重新选择");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/**
 * @param root 主进程已核对的当前笔记库真实路径。
 * @param entries 已解析的拖拽条目；文件夹不能隐式递归导入。
 * @returns 有界文件快照，复用附件上传事务，不向渲染器开放绝对路径读取。
 * @throws 数量超限、目录、符号链接越界、文件变化或读取失败时拒绝整批。
 */
export async function libraryAttachmentUploads(
  root: string,
  entries: LibraryEntriesDrag["entries"],
): Promise<AttachmentUpload[]> {
  if (entries.length > MAX_ATTACHMENTS) throw new Error("一次最多添加八个附件");
  if (entries.some((entry) => entry.kind !== "file"))
    throw new Error("请拖入文件，暂不支持添加文件夹");
  const files: AttachmentUpload[] = [];
  for (const entry of entries) {
    const absolute = await realpath(join(root, entry.path));
    const rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("附件路径越出当前笔记库");
    files.push({ name: basename(entry.path), bytes: await boundedFile(absolute) });
  }
  return files;
}

/** 附件不可变且归属对话；导入整批成功后才交给会话记录发布。 */
export class AttachmentStore {
  /** @param userData 应用私有目录；不读写文件，也不启动原生资源。 */
  constructor(private readonly userData: string) {}

  /** @param id 会话 UUID；@returns 私有目录；@throws 路径身份无效时拒绝。 */
  directory(id: string): string {
    return join(this.userData, "agent-attachments", "published", attachmentId(id));
  }

  private storageDirectory(id: string): string {
    return join(this.userData, "agent-attachments", "owned", attachmentId(id));
  }

  /** @param id 会话 UUID；@returns 已存在的目录；@throws 创建失败时拒绝。 */
  async prepare(id: string): Promise<string> {
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(this.storageDirectory(id), { recursive: true, mode: 0o700 });
    return directory;
  }

  /** @param id 已核对的会话；@param file 已核对的描述；@returns 原始副本路径；@throws 身份非法时拒绝。 */
  path(id: string, file: AgentAttachment): string {
    return join(this.storageDirectory(id), attachmentFilename(file));
  }

  private imagePath(id: string, file: AgentAttachment): string {
    if (!file.image) throw new Error("附件不是图片");
    return join(this.storageDirectory(id), `${attachmentId(file.id)}.image.${file.image.format}`);
  }

  /**
   * @param id 用户选择时捕获的会话。
   * @param paths 系统选择器确认的文件路径，不接受渲染器提供任意读取路径。
   * @returns 原始内容和规范图片均落盘后的描述；中途失败回滚整批。
   * @throws 数量、文件、图片、读写无效时拒绝，不修改原文件。
   */
  async import(id: string, sources: (string | AttachmentUpload)[]): Promise<AgentAttachment[]> {
    if (sources.length > MAX_ATTACHMENTS) throw new Error("一次最多添加八个附件");
    await this.prepare(id);
    const created: string[] = [];
    const result: AgentAttachment[] = [];
    try {
      for (const selected of sources) {
        const uploaded =
          typeof selected === "string" ? null : parseAttachmentUploads([selected])[0]!;
        const bytes =
          typeof selected === "string"
            ? await boundedFile(await realpath(selected))
            : Buffer.from(uploaded!.bytes);
        const image = attachmentImage(bytes);
        const file: AgentAttachment = {
          id: randomUUID(),
          name: typeof selected === "string" ? basename(selected) : selected.name,
          size: bytes.length,
          sha256: digest(bytes),
          image: image
            ? { format: image.format, size: image.bytes.length, sha256: digest(image.bytes) }
            : null,
        };
        parseAttachments([file]);
        const original = this.path(id, file);
        created.push(original);
        await writeFile(original, bytes, { flag: "wx", mode: 0o400 });
        if (image) {
          const normalized = this.imagePath(id, file);
          created.push(normalized);
          await writeFile(normalized, image.bytes, { flag: "wx", mode: 0o400 });
        }
        result.push(file);
      }
      return result;
    } catch (cause) {
      const removed = await Promise.allSettled(created.map((path) => rm(path, { force: true })));
      const failures = removed.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
      if (failures.length)
        throw new AggregateError([cause, ...failures], "附件导入失败且未能完整清理");
      throw cause;
    }
  }

  private async checked(path: string, size: number, sha256: string): Promise<Buffer> {
    const bytes = await boundedFile(path);
    if (bytes.length !== size || digest(bytes) !== sha256)
      throw new Error("附件内容已变化，请重新添加");
    return bytes;
  }

  /**
   * @param id 本次实际发送的会话。
   * @param files 本轮用户明确提交的附件，排队中的附件须等派发才调用。
   * @returns 本次新发布的附件，原生拒绝时可只撤销这些副本；既有历史不受影响。
   * @throws 内容损坏、目录或复制失败时拒绝，不重新创建已变化的发布副本。
   */
  async publish(id: string, files: AgentAttachment[]): Promise<AgentAttachment[]> {
    await this.prepare(id);
    const created: string[] = [];
    try {
      for (const file of files) {
        await this.checked(this.path(id, file), file.size, file.sha256);
        const target = join(this.directory(id), attachmentFilename(file));
        try {
          await this.checked(target, file.size, file.sha256);
          continue;
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
        created.push(target);
        await copyFile(this.path(id, file), target, constants.COPYFILE_EXCL);
      }
      return files.filter((file) =>
        created.includes(join(this.directory(id), attachmentFilename(file))),
      );
    } catch (cause) {
      const cleanup = await Promise.allSettled(created.map((path) => rm(path, { force: true })));
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError([cause, ...failures], "附件发布失败且未能完整回滚");
      throw cause;
    }
  }

  /** @param id 所属会话；@param files 本次新发布且未被原生接受的附件；@returns 撤销工具副本后兑现；@throws 删除失败时拒绝，私有副本始终保留。 */
  async unpublish(id: string, files: AgentAttachment[]): Promise<void> {
    for (const file of files)
      await rm(join(this.directory(id), attachmentFilename(file)), { force: true });
  }

  /** @param id 所属会话；@param files 本轮描述；@returns 原生图片内容；@throws 文件损坏或桥接载荷超限时拒绝。 */
  async images(id: string, files: AgentAttachment[]): Promise<AttachmentImage[]> {
    const images = files.filter((file) => file.image !== null);
    const encodedSize = images.reduce(
      (sum, file) => sum + Math.ceil((file.image?.size ?? 0) / 3) * 4,
      0,
    );
    if (encodedSize > 16 * 1024 * 1024) throw new Error("本轮图片合计过大，请减少图片或缩小尺寸");
    const result: AttachmentImage[] = [];
    for (const file of files) {
      await this.checked(this.path(id, file), file.size, file.sha256);
      if (file.image) {
        const bytes = await this.checked(
          this.imagePath(id, file),
          file.image.size,
          file.image.sha256,
        );
        result.push({ format: file.image.format, data: bytes.toString("base64") });
      }
    }
    return result;
  }

  /** @param id 所属会话；@param file 已核对归属的附件；@returns 图片、有限文本或文件信息；@throws 副本不可读取或损坏时拒绝。 */
  async preview(id: string, file: AgentAttachment): Promise<AttachmentPreview> {
    if (file.image) {
      const [image] = await this.images(id, [file]);
      if (!image) throw new Error("附件图片缺失");
      return { type: "image", url: `data:image/${image.format};base64,${image.data}` };
    }
    const bytes = await this.checked(this.path(id, file), file.size, file.sha256);
    if (bytes.subarray(0, 5).toString() === "%PDF-" || bytes.subarray(0, 128 * 1024).includes(0))
      return { type: "file" };
    try {
      const limit = 128 * 1024;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, limit), {
        stream: bytes.length > limit,
      });
      return { type: "text", text, truncated: bytes.length > limit };
    } catch {
      // 二进制文档仍是完整附件，不把乱码伪装成已提取的正文。
      return { type: "file" };
    }
  }

  /** @param source 来源会话；@param target 分叉会话；@param files 独立保留的文件；@returns 完整复制后兑现；@throws 失败回滚目标目录。 */
  async copy(source: string, target: string, files: AgentAttachment[]): Promise<void> {
    if (!files.length) return;
    await this.prepare(target);
    try {
      for (const file of files) {
        await this.checked(this.path(source, file), file.size, file.sha256);
        await copyFile(this.path(source, file), this.path(target, file), constants.COPYFILE_EXCL);
        if (file.image) {
          await this.checked(this.imagePath(source, file), file.image.size, file.image.sha256);
          await copyFile(
            this.imagePath(source, file),
            this.imagePath(target, file),
            constants.COPYFILE_EXCL,
          );
        }
        const published = join(this.directory(source), attachmentFilename(file));
        try {
          await this.checked(published, file.size, file.sha256);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
          throw cause;
        }
        await this.publish(target, [file]);
      }
    } catch (cause) {
      await this.remove(target);
      throw cause;
    }
  }

  /** @param id 被删除或导入失败的会话；@returns 所有副本移除后兑现；@throws 删除失败时拒绝。 */
  async remove(id: string): Promise<void> {
    await rm(this.directory(id), { recursive: true, force: true });
    await rm(this.storageDirectory(id), { recursive: true, force: true });
  }

  /**
   * @param id 所属会话。
   * @param files 导入回滚或已确认不再被草稿、队列和历史引用的附件。
   * @returns 所有副本撤销后兑现；调用方必须先保存引用变化。
   * @throws 删除失败时拒绝并保留故障信息。
   */
  async discard(id: string, files: AgentAttachment[]): Promise<void> {
    for (const file of files) {
      await rm(join(this.directory(id), attachmentFilename(file)), { force: true });
      await rm(this.path(id, file), { force: true });
      if (file.image) await rm(this.imagePath(id, file), { force: true });
    }
  }
}
