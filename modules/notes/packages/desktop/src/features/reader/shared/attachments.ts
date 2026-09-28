/** 与内核一致的单文件上限，在读取 File 和跨进程复制之前限制内存。 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** 已独占提交的附件；warning 表示索引等后续工作失败，不能重新导入同一文件。 */
export type ImportedAttachment = { path: string; warning: string | null };

/** IPC 用业务结果承载可恢复错误，避免 Electron 把通道名与调用栈混入用户提示。 */
export type AttachmentReply =
  { status: "imported"; attachment: ImportedAttachment } | { status: "failed"; message: string };

/** 解析 IPC 的导入结果；失败抛出原始业务原因，协议不完整时拒绝继续插入。 */
export function parseAttachmentReply(value: unknown): ImportedAttachment {
  if (typeof value === "object" && value !== null && "status" in value) {
    if (value.status === "imported" && "attachment" in value)
      return parseImportedAttachment(value.attachment);
    if (
      value.status === "failed" &&
      "message" in value &&
      typeof value.message === "string" &&
      value.message !== ""
    )
      throw new Error(value.message);
  }
  throw new Error("附件导入响应无效，请检查文件栏中的实际附件后重试");
}

/** 编辑会话捕获的导入能力；切换文档或笔记库后拒绝新请求，不读取任意外部路径。 */
export type AttachmentImporter = (name: string, bytes: Uint8Array) => Promise<ImportedAttachment>;

/** 校验 IPC 请求；路径的库内约束和名称的系统兼容性由内核继续校验。 */
export function parseAttachmentRequest(
  root: unknown,
  from: unknown,
  name: unknown,
  bytes: unknown,
) {
  if (
    typeof root !== "string" ||
    root === "" ||
    typeof from !== "string" ||
    from === "" ||
    typeof name !== "string" ||
    name === ""
  )
    throw new Error("附件导入缺少笔记库、笔记路径或文件名");
  if (!(bytes instanceof Uint8Array)) throw new Error("附件内容不是有效字节");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("附件超过 64 MiB，请缩小文件后重试");
  return { root, from, name, bytes };
}

/** 验证已提交结果；无效路径或警告拒绝传播，避免编辑器构造错误引用。 */
export function parseImportedAttachment(value: unknown): ImportedAttachment {
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path === "" ||
    value.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value.path.includes("\0") ||
    !("warning" in value) ||
    (value.warning !== null && typeof value.warning !== "string")
  )
    throw new Error("附件导入结果无效，请检查文件栏中的实际附件后重试");
  return { path: value.path, warning: value.warning };
}
