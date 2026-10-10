/** 对话里的文件与页面预览；二进制不混入模型文字，也不作为网页脚本执行。 */
export type ContentPreview =
  | { type: "image"; url: string }
  | { type: "pdf"; bytes: Uint8Array }
  | { type: "html"; text: string }
  | { type: "audio" | "video"; mime: string; bytes: Uint8Array }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "file" };

/** 已读取的有界文件快照；另存为使用同一份原始字节，避免预览后内容改变。 */
export type ConversationContent = { name: string; bytes: Uint8Array; preview: ContentPreview };
/** 内容来源决定读取契约；内嵌内容已有快照，附件按身份读取，文件引用按会话目录读取。 */
export type ContentSource =
  | { type: "reference"; reference: string }
  | { type: "attachment"; id: string; name: string }
  | { type: "inline"; file: { name: string; bytes: Uint8Array }; preview: ContentPreview };

/** @param reference 消息中的文件或 URL；@returns 可内嵌类型，普通网页链接返回 null，不抛异常。 */
export function contentKind(
  reference: string,
): "image" | "pdf" | "html" | "text" | "audio" | "video" | null {
  const path = reference.split(/[?#]/u, 1)[0] ?? "";
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension && ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(extension))
    return "image";
  if (extension === "pdf") return "pdf";
  if (extension === "html" || extension === "htm") return "html";
  if (extension && ["mp3", "wav", "m4a", "ogg", "flac"].includes(extension)) return "audio";
  if (extension && ["mp4", "webm", "mov", "ogv"].includes(extension)) return "video";
  if (extension && ["txt", "md", "json", "csv", "xml"].includes(extension)) return "text";
  return null;
}

/**
 * 文件引用只用于提取显示名；解码后的路径分隔符和 ASCII 控制字符也不能进入名称。
 * @param reference 消息中的文件或 URL 引用。
 * @returns 最多 240 个 Unicode 字符的显示名；清理后为空时返回“文件”。
 * @throws 不抛出；百分号编码无效时保留可读的原始末段。
 */
export function contentName(reference: string): string {
  let name = (reference.split(/[?#]/u, 1)[0] ?? "").split(/[\\/]/u).at(-1) ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 非 URL 文件名仍按原文显示。 */
  }
  return (
    [...name]
      .filter(
        (character) =>
          character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          character !== "/" &&
          character !== "\\",
      )
      .slice(0, 240)
      .join("") || "文件"
  );
}

/** @param reference 消息里的外部引用；@returns 不含认证材料的 HTTP(S) 地址，其他协议返回 null。 */
export function remoteContentUrl(reference: string): string | null {
  if (
    [...reference].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(reference);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** @param path 工具参数中的字面路径；@param windows 原生运行平台；@returns 文件 URI 或编码后的相对引用，保留文件名中的 #、? 和百分号，不抛异常。 */
export function fileContentReference(path: string, windows = false): string {
  const normalized = windows ? path.replace(/\\/gu, "/") : path;
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  if (windows && /^[A-Za-z]:\//u.test(normalized))
    return `file:///${encoded.replace(/^([A-Za-z])%3A/u, "$1:")}`;
  return normalized.startsWith("/") ? `file://${encoded}` : encoded;
}
