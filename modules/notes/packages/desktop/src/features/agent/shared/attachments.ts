import { integer, record, text } from "./parse";

/** 与原生媒体预算一致；大文件通过工具读取，不把二进制塞进模型文字。 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** 单次消息最多八个附件，历史拥有的文件不受此列表数量限制。 */
export const MAX_ATTACHMENTS = 8;

/** 附件描述不授予路径访问；主进程核对会话归属后才读取私有副本。 */
export type AgentAttachment = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  image: { format: "png" | "jpeg"; size: number; sha256: string } | null;
};
/** 图片使用原生内容块；文本预览有明确截断标志，其他文件可由用户在系统中打开。 */
export type AttachmentPreview =
  | { type: "image"; url: string }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "file" };
/** 主进程交给原生桥接的冻结图片，Base64 在原生边界再次校验。 */
export type AttachmentImage = { format: "png" | "jpeg"; data: string };
/** 拖入或粘贴的浏览器文件只传字节，不允许渲染器提交任意本地路径。 */
export type AttachmentUpload = { name: string; bytes: Uint8Array };
const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function validName(name: string): boolean {
  return (
    Boolean(name) &&
    name.length <= 1024 &&
    !/[\uD800-\uDFFF]/u.test(name) &&
    Array.from(name).every(
      (character) => character.charCodeAt(0) >= 32 && character !== "/" && character !== "\\",
    )
  );
}

/** @param value 不可信身份；@returns 同一身份；@throws 路径或非 UUID 时拒绝。 */
export function attachmentId(value: unknown): string {
  if (typeof value !== "string" || !identity.test(value)) throw new Error("附件身份无效");
  return value;
}

/** @param value IPC 或草稿中的身份列表；@returns 独立列表；@throws 重复或超过八个时拒绝。 */
export function parseAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error("最多添加八个附件");
  const ids = value.map(attachmentId);
  if (new Set(ids).size !== ids.length) throw new Error("附件身份重复");
  return ids;
}

/** @param value 拖拽或剪贴板的文件快照；@returns 有界文件列表；@throws 类型、数量或大小非法时拒绝。 */
export function parseAttachmentUploads(value: unknown): AttachmentUpload[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error("最多添加八个附件");
  return value.map((raw) => {
    const item = record(raw),
      name = text(item, "name"),
      bytes = item["bytes"];
    if (
      !validName(name) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > MAX_ATTACHMENT_BYTES
    )
      throw new Error("附件文件无效或超过 25 MiB");
    return { name, bytes };
  });
}

/** @param value 磁盘、模型信封或 IPC 元数据；@returns 独立描述；@throws 大小、摘要或文件名非法时拒绝。 */
export function parseAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000) throw new Error("附件目录无效");
  const items = value.map((raw): AgentAttachment => {
    const item = record(raw),
      id = attachmentId(item["id"]),
      name = text(item, "name");
    const size = integer(item, "size"),
      sha256 = text(item, "sha256");
    if (!validName(name) || size > MAX_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/u.test(sha256))
      throw new Error("附件元数据无效");
    let image: AgentAttachment["image"] = null;
    if (item["image"] !== null) {
      const raw = record(item["image"]),
        format = raw["format"],
        size = integer(raw, "size"),
        sha256 = text(raw, "sha256");
      if (
        (format !== "png" && format !== "jpeg") ||
        size < 1 ||
        size > 5 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(sha256)
      )
        throw new Error("附件图片无效");
      image = { format, size, sha256 };
    }
    return { id, name, size, sha256, image };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("附件身份重复");
  return items;
}

/**
 * @param attachment 已校验的描述，显示名不参与路径拼接。
 * @returns 身份与安全扩展名组成的文件名，保持分叉和重启后的读取契约。
 * @throws 身份非法时拒绝。
 */
export function attachmentFilename(attachment: AgentAttachment): string {
  return `${attachmentId(attachment.id)}${attachment.name.match(/\.[A-Za-z0-9]{1,16}$/u)?.[0] ?? ""}`;
}
